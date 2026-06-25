import type { LanguageModelV3 } from "@ai-sdk/provider";
import { ConfigError } from "./errors.js";
import { readEnv } from "./env.js";
import type { ModelRole, ResolvedModel } from "./model.js";
import type { PricingTable } from "./budget.js";
import type { SafetyPolicy } from "./safety.js";
import type { RunStore } from "./providers/store.js";
import type { SearchProvider } from "./providers/search.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { ResearchTool } from "./custom-tools.js";
import type { Researcher } from "./researcher.js";

export type Effort = "fast" | "balanced" | "deep" | "max";

export type TraceMode = "off" | "spans" | "full";

export interface EffortEnvelope {
  budgetUSD: number;
  maxSources: number;
  maxTokens: number;
  maxTurns: number;
  maxReportTokens: number;
}

export const EFFORT_ENVELOPES: Record<Effort, EffortEnvelope> = {
  fast: {
    budgetUSD: 0.5,
    maxSources: 15,
    maxTokens: 5_000_000,
    maxTurns: 30,
    maxReportTokens: 4_096,
  },
  balanced: {
    budgetUSD: 2.5,
    maxSources: 40,
    maxTokens: 20_000_000,
    maxTurns: 60,
    maxReportTokens: 12_288,
  },
  deep: {
    budgetUSD: 10,
    maxSources: 100,
    maxTokens: 80_000_000,
    maxTurns: 100,
    maxReportTokens: 16_384,
  },
  max: {
    budgetUSD: 40,
    maxSources: 250,
    maxTokens: 250_000_000,
    maxTurns: 150,
    maxReportTokens: 24_576,
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
  models?: Partial<Record<Exclude<ModelRole, "lead">, ResolvedModel>>;
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
  if (configured !== undefined && Number.isFinite(configured) && configured >= 1) {
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
    throw new ConfigError(
      'Atlas requires a model instance (e.g. anthropic("claude-fable-5")); model id strings are not accepted',
    );
  }
  const effort = options.effort ?? config.effort ?? "balanced";
  const envelope = EFFORT_ENVELOPES[effort];
  if (!envelope) {
    throw new ConfigError(
      `unknown effort "${effort}" (expected fast | balanced | deep | max)`,
    );
  }
  const budget = { ...config.budget, ...options.budget };
  const budgetUSD = budget.maxUSD ?? envelope.budgetUSD;
  if (!Number.isFinite(budgetUSD) || budgetUSD <= 0) {
    throw new ConfigError(`budget.maxUSD must be > 0 (got ${budgetUSD})`);
  }
  const maxTokens = budget.maxTokens ?? envelope.maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new ConfigError(`budget.maxTokens must be > 0 (got ${maxTokens})`);
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
    maxDurationMs: budget.maxDurationMs,
    maxSources: budget.maxSources ?? envelope.maxSources,
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
