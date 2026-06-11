import type { FlexibleSchema } from "ai";
import { ConfigError } from "./errors.js";
import { deriveSmallModel } from "./defaults.js";
import { readEnv } from "./env.js";
import type { ModelRole, ResolvedModel } from "./model.js";
import type { PricingTable } from "./budget.js";
import type { SafetyPolicy } from "./safety.js";
import type { RunStore } from "./providers/store.js";
import type { SearchProvider } from "./providers/search.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { ResearchTool } from "./custom-tools.js";

export type Effort = "fast" | "balanced" | "deep" | "max";

export interface EffortEnvelope {
  budgetUSD: number;
  depthCap: number;
  breadthCap: number;
  maxSources: number;
  maxTurns: number;
  maxEntailmentChecks: number;
  maxReportTokens: number;
  maxReportCandidates: number;
  maxClaimsPerSource: number;
  maxExtractionChars: number;
}

export const EFFORT_ENVELOPES: Record<Effort, EffortEnvelope> = {
  fast: {
    budgetUSD: 0.5,
    depthCap: 1,
    breadthCap: 1,
    maxSources: 15,
    maxTurns: 30,
    maxEntailmentChecks: 0,
    maxReportTokens: 4_096,
    maxReportCandidates: 12,
    maxClaimsPerSource: 5,
    maxExtractionChars: 40_000,
  },
  balanced: {
    budgetUSD: 2.5,
    depthCap: 2,
    breadthCap: 4,
    maxSources: 40,
    maxTurns: 60,
    maxEntailmentChecks: 60,
    maxReportTokens: 8_192,
    maxReportCandidates: 20,
    maxClaimsPerSource: 6,
    maxExtractionChars: 60_000,
  },
  deep: {
    budgetUSD: 10,
    depthCap: 3,
    breadthCap: 8,
    maxSources: 100,
    maxTurns: 100,
    maxEntailmentChecks: 150,
    maxReportTokens: 16_384,
    maxReportCandidates: 40,
    maxClaimsPerSource: 8,
    maxExtractionChars: 100_000,
  },
  max: {
    budgetUSD: 40,
    depthCap: 4,
    breadthCap: 12,
    maxSources: 250,
    maxTurns: 150,
    maxEntailmentChecks: 400,
    maxReportTokens: 24_576,
    maxReportCandidates: 60,
    maxClaimsPerSource: 10,
    maxExtractionChars: 150_000,
  },
};

export interface Budget {
  maxUSD?: number;
  maxDurationMs?: number;
  maxSources?: number;
}

export interface SourceFilter {
  includeDomains?: string[];
  excludeDomains?: string[];
}

export type OutputSpec =
  | { kind: "report" }
  | { kind: "structured"; schema: FlexibleSchema };

export interface AtlasConfig {
  model: ResolvedModel;
  models?: Partial<Record<ModelRole, ResolvedModel>>;
  search?: SearchProvider | SearchProvider[];
  fetch?: FetchProvider | FetchProvider[];
  effort?: Effort;
  budget?: Budget;
  store?: RunStore;
  pricing?: PricingTable;
  safety?: SafetyPolicy;
  instructions?: string;
  tools?: Record<string, ResearchTool>;
}

export interface ResearchOptions {
  effort?: Effort;
  budget?: Budget;
  output?: OutputSpec;
  sources?: SourceFilter;
  signal?: AbortSignal;
  runId?: string;
  now?: () => number;
}

export interface ResolvedRunConfig {
  effort: Effort;
  envelope: EffortEnvelope;
  budgetUSD: number;
  maxDurationMs?: number | undefined;
  maxSources: number;
  models: Record<ModelRole, ResolvedModel>;
  pricing: PricingTable;
  safety: SafetyPolicy;
  sourceFilter?: SourceFilter | undefined;
  instructions?: string | undefined;
  output: OutputSpec;
  maxConcurrentModelCalls: number;
  maxConcurrentIo: number;
}

const DEFAULT_MODEL_CONCURRENCY = 8;
const DEFAULT_IO_CONCURRENCY = 10;

function concurrencyFromEnv(fallback: number, ...keys: string[]): number {
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
  const lead = config.model;
  const derived =
    config.models?.extract && config.models?.verify
      ? undefined
      : deriveSmallModel(lead);
  const models: Record<ModelRole, ResolvedModel> = {
    lead: config.models?.lead ?? lead,
    research: config.models?.research ?? config.models?.lead ?? lead,
    verify: config.models?.verify ?? derived ?? lead,
    extract: config.models?.extract ?? derived ?? lead,
    write: config.models?.write ?? config.models?.lead ?? lead,
  };
  return {
    effort,
    envelope,
    budgetUSD,
    maxDurationMs: budget.maxDurationMs,
    maxSources: budget.maxSources ?? envelope.maxSources,
    models,
    pricing: config.pricing ?? {},
    safety: config.safety ?? {},
    sourceFilter: options.sources,
    instructions: config.instructions,
    output: options.output ?? { kind: "report" },
    maxConcurrentModelCalls: concurrencyFromEnv(
      DEFAULT_MODEL_CONCURRENCY,
      "ATLAS_MODEL_CONCURRENCY",
    ),
    maxConcurrentIo: concurrencyFromEnv(
      DEFAULT_IO_CONCURRENCY,
      "ATLAS_IO_CONCURRENCY",
    ),
  };
}
