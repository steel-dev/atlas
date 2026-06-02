import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
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
import type { ResearchEvent, ResearchOptions } from "./research.js";

const DEFAULT_RUNTIME_LIMITS = {
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 10,
  maxDelegationDepth: 1,
  maxConcurrentSubagents: 3,
  defaultSearchLimit: 8,
  maxOutputTokens: 16_384,
  timeoutSynthesisReserveMs: 180_000,
  compactionTriggerTokens: 200_000,
  compactionKeepTokens: 100_000,
  subagentCompactionTriggerTokens: 100_000,
  subagentCompactionKeepTokens: 50_000,
};

// Caps total in-flight model connections across the lead, every sub-agent, and
// their compaction/digest calls. A dedicated sub-agent semaphore bounds fan-out
// to maxConcurrentSubagents live sub-agents; this adds headroom on top so the
// lead is never starved while that many sub-agents call the model. Derived from
// the fan-out width unless ATLAS_MAX_CONCURRENT_MODEL_CALLS overrides it.
const MODEL_CALL_HEADROOM = 1;

// Total token budget = the single test-time compute knob. Tool-call and source
// safety caps are derived from it (and floored) so the token budget — not a
// hand-tuned effort multiplier — is what governs how far a run scales.
const DEFAULT_TOKEN_LIMIT = 2_000_000;
const TOKENS_PER_TOOL_CALL = 8_000;
const TOKENS_PER_SOURCE = 20_000;
const MIN_SAFETY_TOOL_CALLS = 40;
const MIN_SAFETY_SOURCE_CAP = 80;
const MAX_TEAM_SIZE = 8;

export const RUNTIME_LIMITS = DEFAULT_RUNTIME_LIMITS;

export interface ResolvedRunConfig {
  provider: ModelProvider;
  model: string;
  summaryModel: string;
  steelApiKey: string;
  steelBaseUrl?: string;
  useProxy: boolean;
  safetyMaxToolCalls: number;
  suggestedTeamSize: number;
  maxConcurrentModelCalls: number;
  maxConcurrentSteelCalls: number;
  compactionTriggerTokens: number;
  compactionKeepTokens: number;
  timeoutDeadlineAt?: number;
  synthesisReserveMs?: number;
  browserMaxSessions: number;
  browserIdleTtlMs?: number | null;
  search?: SearchProvider;
  agent: ResearchConfig;
}

export interface RunResources {
  modelAdapter: ModelAdapter;
  summaryAdapter: ModelAdapter;
  steel: ReturnType<typeof createSteel>;
  browserSessionPool: BrowserSessionPool;
}

export function resolveRunConfig(opts: ResearchOptions): ResolvedRunConfig {
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
    readIntEnv("ATLAS_TOKEN_LIMIT", 0) ??
    DEFAULT_TOKEN_LIMIT;
  const effectiveLimitForCaps =
    tokenLimit > 0 ? tokenLimit : DEFAULT_TOKEN_LIMIT;
  const suggestedTeamSize = Math.min(
    MAX_TEAM_SIZE,
    Math.max(
      1,
      opts.suggestedTeamSize ?? readIntEnv("ATLAS_TEAM_SIZE", 1) ?? 1,
    ),
  );
  const maxConcurrentSubagents = Math.max(
    readIntEnv("ATLAS_MAX_SUBAGENTS", 1) ?? limits.maxConcurrentSubagents,
    suggestedTeamSize,
  );

  const agent: ResearchConfig = {
    useProxy,
    sourceCap: Math.max(
      MIN_SAFETY_SOURCE_CAP,
      Math.ceil(effectiveLimitForCaps / TOKENS_PER_SOURCE),
    ),
    maxOutputTokens: limits.maxOutputTokens,
    defaultSearchLimit: limits.defaultSearchLimit,
    maxConcurrentTools: limits.maxConcurrentTools,
    subagentCompactionTriggerTokens: limits.subagentCompactionTriggerTokens,
    subagentCompactionKeepTokens: limits.subagentCompactionKeepTokens,
    tokenLimit,
    maxDelegationDepth:
      readIntEnv("ATLAS_MAX_DELEGATION_DEPTH", 0) ?? limits.maxDelegationDepth,
    maxConcurrentSubagents,
    exploreProviderOptions: opts.exploreProviderOptions,
    finalizeProviderOptions: opts.finalizeProviderOptions,
  };

  return {
    provider,
    model,
    summaryModel: opts.summaryModel
      ? modelLabel(opts.summaryModel).modelId
      : model,
    steelApiKey,
    steelBaseUrl:
      browser?.baseUrl ?? readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL"),
    useProxy,
    safetyMaxToolCalls: Math.max(
      MIN_SAFETY_TOOL_CALLS,
      Math.ceil(effectiveLimitForCaps / TOKENS_PER_TOOL_CALL),
    ),
    suggestedTeamSize,
    maxConcurrentModelCalls:
      readIntEnv("ATLAS_MAX_CONCURRENT_MODEL_CALLS", 1) ??
      maxConcurrentSubagents + MODEL_CALL_HEADROOM,
    maxConcurrentSteelCalls: limits.maxConcurrentSteelCalls,
    compactionTriggerTokens:
      readIntEnv("ATLAS_COMPACTION_TRIGGER_TOKENS", 0) ??
      limits.compactionTriggerTokens,
    compactionKeepTokens:
      readIntEnv("ATLAS_COMPACTION_KEEP_TOKENS", 0) ??
      limits.compactionKeepTokens,
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
      readBrowserMaxSessionsFromEnv() ??
      defaultBrowserMaxSessions(maxConcurrentSubagents),
    browserIdleTtlMs: readBrowserIdleTtlMsFromEnv(),
    search: opts.search,
  };
}

// Creates the long-lived clients, gates, and the browser pool the run owns. The
// lead and summary models share one concurrency gate so the total in-flight
// model connections stay bounded across the whole run.
export function createRunResources(
  opts: ResearchOptions,
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
  const summaryAdapter = opts.summaryModel
    ? wrap(opts.summaryModel, modelLabel(opts.summaryModel))
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
  return { modelAdapter, summaryAdapter, steel, browserSessionPool };
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

function resolveSummaryModel(
  summaryModel: string | undefined,
  mainModel: string,
): string {
  const raw = summaryModel ?? readEnv("ATLAS_SUMMARY_MODEL");
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
  summaryModel?: string;
  baseUrl?: string;
}

export function resolveModelSpec(opts: ModelSpecInput): {
  model: Exclude<LanguageModel, string>;
  summaryModel?: Exclude<LanguageModel, string>;
} {
  const provider = resolveProvider(opts.provider);
  const modelId = resolveModel(provider, opts.model);
  const baseUrl =
    opts.baseUrl ?? readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
  const model = buildLanguageModel(provider, modelId, baseUrl);
  const summaryId = resolveSummaryModel(opts.summaryModel, modelId);
  return summaryId === modelId
    ? { model }
    : { model, summaryModel: buildLanguageModel(provider, summaryId, baseUrl) };
}

function buildLanguageModel(
  provider: ModelProvider,
  modelId: string,
  baseUrl: string | undefined,
): Exclude<LanguageModel, string> {
  if (provider === "openai") {
    return createOpenAI({
      apiKey: readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY"),
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })(modelId);
  }
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
