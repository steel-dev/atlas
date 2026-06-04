import {
  createAISdkModelAdapter,
  wrapModelAdapterWithConcurrency,
  type LanguageModel,
  type ModelAdapter,
  type ModelProvider,
  type ModelRetryInfo,
} from "./model.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from "./defaults.js";
import { createSteel } from "./steel.js";
import type { SearchProvider } from "./search-provider.js";
import { readEnv } from "./env.js";
import {
  createAdaptiveConcurrencyGate,
  type ResearchConfig,
} from "./runtime.js";
import {
  BrowserSessionPool,
  defaultBrowserMaxSessions,
  readBrowserIdleTtlMsFromEnv,
  readBrowserMaxSessionsFromEnv,
} from "./browser-session-pool.js";
import type { ResearchDepth, ResearchEvent, RunInput } from "./research.js";

const DEFAULT_RUNTIME_LIMITS = {
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 10,
  maxConcurrentModelCalls: 8,
  defaultSearchLimit: 8,
  maxOutputTokens: 16_384,
  timeoutSynthesisReserveMs: 180_000,
};

// Total token budget = the single test-time compute knob. Tool-call and source
// safety caps are derived from it (and floored) so the token budget — not a
// hand-tuned effort multiplier — is what governs how far a run scales.
const DEFAULT_TOKEN_LIMIT = 2_000_000;
const DEPTH_TOKEN_LIMITS: Record<ResearchDepth, number> = {
  quick: 500_000,
  standard: 2_000_000,
  deep: 8_000_000,
};
const TOKENS_PER_TOOL_CALL = 8_000;
const TOKENS_PER_SOURCE = 20_000;
const TOKENS_PER_CONFIRMED_CLAIM = 40_000;
const MIN_SAFETY_TOOL_CALLS = 40;
const MIN_SAFETY_SOURCE_CAP = 80;
const MIN_VERIFY_TARGET = 25;
const MAX_VERIFY_TARGET = 60;

export const RUNTIME_LIMITS = DEFAULT_RUNTIME_LIMITS;

export interface ResolvedRunConfig {
  provider: ModelProvider;
  model: string;
  leafModel: string;
  steelApiKey: string;
  steelBaseUrl?: string;
  useProxy: boolean;
  safetyMaxToolCalls: number;
  maxConcurrentModelCalls: number;
  maxConcurrentSteelCalls: number;
  timeoutDeadlineAt?: number;
  synthesisReserveMs?: number;
  browserMaxSessions: number;
  browserIdleTtlMs?: number | null;
  search?: SearchProvider;
  agent: ResearchConfig;
}

export interface RunResources {
  modelAdapter: ModelAdapter;
  leafAdapter: ModelAdapter;
  steel: ReturnType<typeof createSteel>;
  browserSessionPool: BrowserSessionPool;
}

export function resolveRunConfig(opts: RunInput): ResolvedRunConfig {
  const limits = DEFAULT_RUNTIME_LIMITS;
  const { provider, modelId: model } = modelLabel(opts.model);
  const browser = opts.browser;
  const steelApiKey =
    browser?.apiKey ?? readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY");
  if (!steelApiKey) {
    throw new Error(
      "research: STEEL_API_KEY or ATLAS_STEEL_API_KEY is required (or pass browser: steel({ apiKey }))",
    );
  }

  const useProxy = browser?.proxy ?? false;
  const tokenLimit =
    opts.tokenLimit ??
    (opts.depth ? DEPTH_TOKEN_LIMITS[opts.depth] : undefined) ??
    readIntEnv("ATLAS_TOKEN_LIMIT", 0) ??
    DEFAULT_TOKEN_LIMIT;
  const effectiveLimitForCaps =
    tokenLimit > 0 ? tokenLimit : DEFAULT_TOKEN_LIMIT;

  const agent: ResearchConfig = {
    useProxy,
    sourceCap: Math.max(
      MIN_SAFETY_SOURCE_CAP,
      Math.ceil(effectiveLimitForCaps / TOKENS_PER_SOURCE),
    ),
    verifyTargetConfirmed: Math.min(
      MAX_VERIFY_TARGET,
      Math.max(
        MIN_VERIFY_TARGET,
        Math.ceil(effectiveLimitForCaps / TOKENS_PER_CONFIRMED_CLAIM),
      ),
    ),
    maxOutputTokens: limits.maxOutputTokens,
    defaultSearchLimit: limits.defaultSearchLimit,
    maxConcurrentTools: limits.maxConcurrentTools,
    tokenLimit,
    verifierPanel: resolveVerifierPanel(opts.verifierPanel),
    exploreProviderOptions: opts.exploreProviderOptions,
    finalizeProviderOptions: opts.finalizeProviderOptions,
    instructions: opts.instructions,
  };

  return {
    provider,
    model,
    leafModel: opts.leafModel ? modelLabel(opts.leafModel).modelId : model,
    steelApiKey,
    steelBaseUrl:
      browser?.baseUrl ?? readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL"),
    useProxy,
    safetyMaxToolCalls: Math.max(
      MIN_SAFETY_TOOL_CALLS,
      Math.ceil(effectiveLimitForCaps / TOKENS_PER_TOOL_CALL),
    ),
    maxConcurrentModelCalls:
      readIntEnv("ATLAS_MAX_CONCURRENT_MODEL_CALLS", 1) ??
      limits.maxConcurrentModelCalls,
    maxConcurrentSteelCalls: limits.maxConcurrentSteelCalls,
    agent,
    timeoutDeadlineAt:
      opts.timeoutMs === undefined
        ? undefined
        : Date.now() + Math.floor(opts.timeoutMs),
    synthesisReserveMs:
      opts.timeoutMs === undefined
        ? undefined
        : timeoutSynthesisReserveMs(
            opts.timeoutMs,
            limits.timeoutSynthesisReserveMs,
          ),
    browserMaxSessions:
      readBrowserMaxSessionsFromEnv() ?? defaultBrowserMaxSessions(0),
    browserIdleTtlMs: readBrowserIdleTtlMsFromEnv(),
    search: opts.search,
  };
}

// Creates the long-lived clients, gates, and the browser pool the run owns. The
// lead and leaf models share one concurrency gate so the total in-flight model
// connections stay bounded across the whole run.
export function createRunResources(
  opts: RunInput,
  config: ResolvedRunConfig,
  runSignal: AbortSignal | undefined,
  emit: (event: ResearchEvent) => void,
): RunResources {
  // Adaptive ceiling: starts at the configured width and shrinks under a
  // "concurrent connections exceeded" 429, so the run converges on the
  // concurrency the account actually allows instead of dying on it.
  const modelCallGate = createAdaptiveConcurrencyGate(
    config.maxConcurrentModelCalls,
  );
  const concurrencyOptions = {
    onRetry: (info: ModelRetryInfo) =>
      emit({
        type: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(info.delayMs / 1000)),
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
      }),
  };
  const wrap = (
    model: Exclude<LanguageModel, string>,
    label: { provider: ModelProvider; modelId: string },
  ) =>
    wrapModelAdapterWithConcurrency(
      createAISdkModelAdapter({
        model,
        provider: label.provider,
        modelId: label.modelId,
      }),
      modelCallGate,
      concurrencyOptions,
    );
  const modelAdapter = wrap(opts.model, {
    provider: config.provider,
    modelId: config.model,
  });
  const leafAdapter = opts.leafModel
    ? wrap(opts.leafModel, modelLabel(opts.leafModel))
    : modelAdapter;
  const steel = createSteel({
    apiKey: config.steelApiKey,
    baseUrl: config.steelBaseUrl,
  });
  const browserSessionPool = new BrowserSessionPool({
    steel,
    useProxy: config.useProxy,
    namespace: `atlas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    signal: runSignal,
    deadlineAt: config.timeoutDeadlineAt,
    maxSessions: config.browserMaxSessions,
    idleTtlMs: config.browserIdleTtlMs,
  });
  return { modelAdapter, leafAdapter, steel, browserSessionPool };
}

function resolveVerifierPanel(
  explicit: "lens" | "clone" | undefined,
): "lens" | "clone" | undefined {
  const raw = explicit ?? readEnv("ATLAS_VERIFIER_PANEL");
  return raw === "lens" || raw === "clone" ? raw : undefined;
}

function readIntEnv(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= min ? n : undefined;
}

function resolveProvider(provider: ModelProvider | undefined): ModelProvider {
  const raw = provider ?? readEnv("ATLAS_PROVIDER");
  if (raw === "anthropic" || raw === "openai") return raw;
  if (raw) {
    throw new Error(
      `research: provider must be one of: anthropic, openai (got "${raw}")`,
    );
  }
  const hasOpenAI = Boolean(readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY"));
  const hasAnthropic = Boolean(
    readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
  );
  return hasOpenAI && !hasAnthropic ? "openai" : "anthropic";
}

function resolveModel(
  provider: ModelProvider,
  model: string | undefined,
): string {
  const raw =
    model ??
    readEnv(
      "ATLAS_MODEL",
      provider === "anthropic" ? "ATLAS_ANTHROPIC_MODEL" : "ATLAS_OPENAI_MODEL",
    );
  if (raw?.trim()) return raw.trim();
  return provider === "anthropic"
    ? DEFAULT_ANTHROPIC_MODEL
    : DEFAULT_OPENAI_MODEL;
}

function resolveLeafModel(
  leafModel: string | undefined,
  mainModel: string,
): string {
  const raw = leafModel ?? readEnv("ATLAS_LEAF_MODEL");
  if (raw?.trim()) return raw.trim();
  return mainModel;
}

function modelLabel(model: Exclude<LanguageModel, string>): {
  provider: ModelProvider;
  modelId: string;
} {
  return { provider: model.provider.split(".")[0], modelId: model.modelId };
}

interface ModelSpecInput {
  provider?: ModelProvider;
  model?: string;
  leafModel?: string;
}

export async function resolveModelSpec(opts: ModelSpecInput): Promise<{
  model: Exclude<LanguageModel, string>;
  leafModel?: Exclude<LanguageModel, string>;
}> {
  const provider = resolveProvider(opts.provider);
  const modelId = resolveModel(provider, opts.model);
  const model = await buildLanguageModel(provider, modelId);
  const leafId = resolveLeafModel(opts.leafModel, modelId);
  return leafId === modelId
    ? { model }
    : {
        model,
        leafModel: await buildLanguageModel(provider, leafId),
      };
}

async function buildLanguageModel(
  provider: ModelProvider,
  modelId: string,
): Promise<Exclude<LanguageModel, string>> {
  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({
      apiKey: readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY"),
    })(modelId);
  }
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({
    apiKey: readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
  })(modelId);
}

function timeoutSynthesisReserveMs(
  timeoutMs: number,
  maxReserveMs: number,
): number {
  const normalizedTimeoutMs = Math.floor(timeoutMs);
  const preferredReserveMs = Math.max(
    15_000,
    Math.floor(normalizedTimeoutMs * 0.25),
  );
  return Math.min(
    maxReserveMs,
    preferredReserveMs,
    Math.max(1_000, Math.floor(normalizedTimeoutMs * 0.5)),
  );
}
