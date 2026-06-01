import {
  createAnthropicModelAdapter,
  createOpenAIModelAdapter,
  wrapModelAdapterWithConcurrency,
  type ModelAdapter,
  type ModelProvider,
  type ModelRetryInfo,
} from "./model.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_SUMMARY_MODEL,
  DEFAULT_OPENAI_MODEL,
  type ResearchEffort,
} from "./defaults.js";
import { createSteel } from "./steel.js";
import type { SearchProviderResolution } from "./search-provider.js";
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
// Thinking stays always-on adaptive; this is only the per-step effort hint.
// Override with ATLAS_THINKING_EFFORT (e.g. =max for system-card parity).
const DEFAULT_THINKING_EFFORT: ResearchEffort = "high";
const MAX_TEAM_SIZE = 8;

export const RUNTIME_LIMITS = DEFAULT_RUNTIME_LIMITS;

export interface ResolvedRunConfig {
  provider: ModelProvider;
  model: string;
  summaryModel: string;
  steelApiKey: string;
  steelBaseUrl?: string;
  useProxy: boolean;
  thinkingEffort: ResearchEffort;
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
  searchProvider: SearchProviderResolution;
  agent: ResearchConfig;
}

export interface RunResources {
  modelAdapter: ModelAdapter;
  summaryAdapter: ModelAdapter;
  steel: ReturnType<typeof createSteel>;
  browserSessionPool: BrowserSessionPool;
}

// Resolves every knob from explicit options then environment then defaults, with
// no side effects (no clients, gates, or pools) so the resolution can be tested
// in isolation. The token budget is the single scaling knob; tool-call and
// source caps are derived from it and floored.
export function resolveRunConfig(opts: ResearchOptions): ResolvedRunConfig {
  const limits = DEFAULT_RUNTIME_LIMITS;
  const provider = resolveProvider(opts.provider);
  const model = resolveModel(provider, opts.model);
  const steelApiKey =
    opts.steelApiKey ?? readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY");
  if (!steelApiKey) {
    throw new Error(
      "research: STEEL_API_KEY or ATLAS_STEEL_API_KEY is required",
    );
  }

  const useProxy = opts.useProxy ?? false;
  const thinkingEffort = resolveThinkingEffort();
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
    subagentEffort: thinkingEffort,
  };

  return {
    provider,
    model,
    summaryModel: resolveSummaryModel(provider, opts.summaryModel, model),
    steelApiKey,
    steelBaseUrl:
      opts.steelBaseUrl ?? readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL"),
    useProxy,
    thinkingEffort,
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
    searchProvider: {
      instance:
        opts.searchProvider && typeof opts.searchProvider !== "string"
          ? opts.searchProvider
          : undefined,
      kind:
        (typeof opts.searchProvider === "string"
          ? opts.searchProvider
          : undefined) ?? readEnv("ATLAS_SEARCH_PROVIDER"),
      exaApiKey: opts.exaApiKey ?? readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY"),
      braveApiKey:
        opts.braveApiKey ?? readEnv("ATLAS_BRAVE_API_KEY", "BRAVE_API_KEY"),
    },
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
  const modelKeys = {
    anthropicApiKey: opts.anthropicApiKey,
    openaiApiKey: opts.openaiApiKey,
    openaiBaseUrl: opts.openaiBaseUrl,
  };
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
  const modelAdapter = wrapModelAdapterWithConcurrency(
    createModelAdapter({
      provider: config.provider,
      model: config.model,
      ...modelKeys,
    }),
    modelCallGate,
    concurrencyOptions,
  );
  const summaryAdapter =
    config.summaryModel === config.model
      ? modelAdapter
      : wrapModelAdapterWithConcurrency(
          createModelAdapter({
            provider: config.provider,
            model: config.summaryModel,
            ...modelKeys,
          }),
          modelCallGate,
          concurrencyOptions,
        );
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

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function readIntEnv(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= min ? n : undefined;
}

function resolveThinkingEffort(): ResearchEffort {
  const raw = readEnv("ATLAS_THINKING_EFFORT");
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "max") {
    return raw;
  }
  if (raw) {
    throw new Error(
      `research: ATLAS_THINKING_EFFORT must be one of: low, medium, high, max (got "${raw}")`,
    );
  }
  return DEFAULT_THINKING_EFFORT;
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
  provider: ModelProvider,
  summaryModel: string | undefined,
  mainModel: string,
): string {
  const raw = summaryModel ?? readEnv("ATLAS_SUMMARY_MODEL");
  if (raw?.trim()) return raw.trim();
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_SUMMARY_MODEL : mainModel;
}

function createModelAdapter(opts: {
  provider: ModelProvider;
  model: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): ModelAdapter {
  if (opts.provider === "anthropic") {
    const apiKey =
      opts.anthropicApiKey ??
      readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "research: ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY is required for provider=anthropic",
      );
    }
    // maxRetries: 0 — the resilience wrapper owns rate-limit/transient retries
    // so a sleeping retry frees its gate slot instead of pinning a connection.
    return createAnthropicModelAdapter({
      apiKey,
      model: opts.model,
      maxRetries: 0,
    });
  }

  const apiKey =
    opts.openaiApiKey ?? readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  const baseUrl =
    opts.openaiBaseUrl ?? readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
  if (!apiKey) {
    throw new Error(
      "research: OPENAI_API_KEY or ATLAS_OPENAI_API_KEY is required for provider=openai",
    );
  }
  return createOpenAIModelAdapter({
    apiKey,
    baseUrl,
    model: opts.model,
    maxRetries: 0,
  });
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
