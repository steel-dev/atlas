import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { PricingTable } from "./budget.js";
import type { ResearchTool } from "./custom-tools.js";
import { readEnv } from "./env.js";
import { AtlasError } from "./errors.js";
import type { ModelRole, ResolvedModel } from "./model.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { SearchProvider } from "./providers/search.js";
import type { RunStore } from "./providers/store.js";
import type { Researcher } from "./researcher.js";
import type { SafetyPolicy } from "./safety.js";

export type Effort = "fast" | "balanced" | "deep" | "max";

export type TraceMode = "off" | "spans" | "full";

export interface EffortEnvelope {
  budgetUSD: number;
  maxSources: number;
  maxTokens: number;
  maxTurns: number;
  maxReportTokens: number;
  maxDurationMs: number;
}

export const EFFORT_ENVELOPES: Record<Effort, EffortEnvelope> = {
  fast: {
    budgetUSD: 0.5,
    maxSources: 15,
    maxTokens: 200_000,
    maxTurns: 30,
    maxReportTokens: 4_096,
    maxDurationMs: 600_000,
  },
  balanced: {
    budgetUSD: 2.5,
    maxSources: 40,
    maxTokens: 1_000_000,
    maxTurns: 60,
    maxReportTokens: 12_288,
    maxDurationMs: 1_200_000,
  },
  deep: {
    budgetUSD: 10,
    maxSources: 100,
    maxTokens: 4_000_000,
    maxTurns: 100,
    maxReportTokens: 16_384,
    maxDurationMs: 2_400_000,
  },
  max: {
    budgetUSD: 40,
    maxSources: 250,
    maxTokens: 16_000_000,
    maxTurns: 150,
    maxReportTokens: 24_576,
    maxDurationMs: 3_600_000,
  },
};
for (const envelope of Object.values(EFFORT_ENVELOPES)) {
  Object.freeze(envelope);
}
Object.freeze(EFFORT_ENVELOPES);

export interface Budget {
  maxUSD?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxSources?: number;
}

export interface SourceFilter {
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface ConcurrencyConfig {
  models?: number;
  io?: number;
}

export type SearchConfig =
  | SearchProvider
  | SearchProvider[]
  | Record<string, SearchProvider | SearchProvider[]>;

export interface AtlasConfig {
  model: ResolvedModel;
  models?: { research?: ResolvedModel; write?: ResolvedModel };
  search?: SearchConfig;
  fetch?: FetchProvider | FetchProvider[];
  effort?: Effort;
  budget?: Budget;
  store?: RunStore;
  pricing?: PricingTable;
  safety?: SafetyPolicy;
  instructions?: string;
  tools?: Record<string, ResearchTool>;
  researchers?: Record<string, Researcher>;
  concurrency?: ConcurrencyConfig;
  trace?: TraceMode;
}

export interface ResearchOptions {
  effort?: Effort;
  budget?: Budget;
  sources?: SourceFilter;
  signal?: AbortSignal;
  runId?: string;
  trace?: TraceMode;
}

export interface ResolvedRunConfig {
  effort: Effort;
  envelope: EffortEnvelope;
  budgetUSD: number;
  maxTokens: number;
  maxDurationMs?: number | undefined;
  maxSources: number;
  models: Record<ModelRole, ResolvedModel>;
  leadModelId: string;
  pricing: PricingTable;
  safety: SafetyPolicy;
  sourceFilter?: SourceFilter | undefined;
  instructions?: string | undefined;
  maxConcurrentModelCalls: number;
  maxConcurrentIo: number;
  trace: TraceMode;
  researchers: Record<string, Researcher>;
}

const DEFAULT_MODEL_CONCURRENCY = 4;
const DEFAULT_IO_CONCURRENCY = 10;

function resolveConcurrency(
  configured: number | undefined,
  fallback: number,
  ...keys: string[]
): number {
  if (
    configured !== undefined &&
    Number.isFinite(configured) &&
    configured >= 1
  ) {
    return Math.floor(configured);
  }
  const raw = readEnv(...keys);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function resolveRunConfig(
  config: AtlasConfig,
  options: ResearchOptions,
): ResolvedRunConfig {
  if (!config.model || typeof config.model === "string") {
    throw new AtlasError(
      'Atlas requires a model instance (e.g. anthropic("claude-fable-5")); model id strings are not accepted',
      "config",
    );
  }
  const effort = options.effort ?? config.effort ?? "balanced";
  const envelope = EFFORT_ENVELOPES[effort];
  if (!envelope) {
    throw new AtlasError(
      `unknown effort "${effort}" (expected fast | balanced | deep | max)`,
      "config",
    );
  }
  const budget = { ...config.budget, ...options.budget };
  const budgetUSD = budget.maxUSD ?? envelope.budgetUSD;
  if (!Number.isFinite(budgetUSD) || budgetUSD <= 0) {
    throw new AtlasError(
      `budget.maxUSD must be > 0 (got ${budgetUSD})`,
      "config",
    );
  }
  const maxTokens = budget.maxTokens ?? envelope.maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new AtlasError(
      `budget.maxTokens must be > 0 (got ${maxTokens})`,
      "config",
    );
  }
  const maxSources = budget.maxSources ?? envelope.maxSources;
  if (!Number.isFinite(maxSources) || maxSources <= 0) {
    throw new AtlasError(
      `budget.maxSources must be > 0 (got ${maxSources})`,
      "config",
    );
  }
  const maxDurationMs = budget.maxDurationMs ?? envelope.maxDurationMs;
  if (
    maxDurationMs !== undefined &&
    (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0)
  ) {
    throw new AtlasError(
      `budget.maxDurationMs must be > 0 (got ${maxDurationMs})`,
      "config",
    );
  }
  const lead = config.model;
  const models: Record<ModelRole, ResolvedModel> = {
    lead,
    research: config.models?.research ?? lead,
    write: config.models?.write ?? lead,
  };
  const leadModelId = (lead as LanguageModelV3).modelId ?? "";
  return {
    effort,
    envelope,
    budgetUSD,
    maxTokens,
    maxDurationMs,
    maxSources,
    models,
    leadModelId,
    pricing: config.pricing ?? {},
    safety: config.safety ?? {},
    sourceFilter: options.sources,
    instructions: config.instructions,
    maxConcurrentModelCalls: resolveConcurrency(
      config.concurrency?.models,
      DEFAULT_MODEL_CONCURRENCY,
      "ATLAS_MODEL_CONCURRENCY",
    ),
    maxConcurrentIo: resolveConcurrency(
      config.concurrency?.io,
      DEFAULT_IO_CONCURRENCY,
      "ATLAS_IO_CONCURRENCY",
    ),
    trace: options.trace ?? config.trace ?? "off",
    researchers: config.researchers ?? {},
  };
}
