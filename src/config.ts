import type { FlexibleSchema } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { ConfigError } from "./errors.js";
import { deriveSmallModel, isSmallModelId } from "./defaults.js";
import { readEnv } from "./env.js";
import type { ModelRole, ResolvedModel } from "./model.js";
import type { PricingTable } from "./budget.js";
import type { SafetyPolicy } from "./safety.js";
import type { RunStore } from "./providers/store.js";
import type { SearchProvider } from "./providers/search.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { ResearchTool } from "./custom-tools.js";

export type Effort = "fast" | "balanced" | "deep" | "max";

export type TraceMode = "off" | "spans" | "full";

export interface EffortEnvelope {
  budgetUSD: number;
  depthCap: number;
  breadthCap: number;
  maxSources: number;
  maxTokens: number;
  maxAgents: number;
  minFacets: number;
  maxTurns: number;
  maxSubagentTurns: number;
  maxEntailmentChecks: number;
  maxReportTokens: number;
  maxReportCandidates: number;
  maxReportClaims: number;
  maxClaimsPerSource: number;
  maxExtractionChars: number;
  maxAdjudicationRounds: number;
  verifyReserveFraction: number;
  verifierFetch: boolean;
  verifierMaxTurns: number;
  panelModelRole: ModelRole;
  panelGrantUSD: number;
  leadContextTokens: number;
  maxLeadSessions: number;
  digestClaims: number;
  maxConflictClaims: number;
  maxConflictPairs: number;
}

export const EFFORT_ENVELOPES: Record<Effort, EffortEnvelope> = {
  fast: {
    budgetUSD: 0.5,
    depthCap: 1,
    breadthCap: 1,
    maxSources: 15,
    maxTokens: 5_000_000,
    maxAgents: 20,
    minFacets: 1,
    maxTurns: 30,
    maxSubagentTurns: 15,
    maxEntailmentChecks: 0,
    maxReportTokens: 4_096,
    maxReportCandidates: 12,
    maxReportClaims: 30,
    maxClaimsPerSource: 5,
    maxExtractionChars: 40_000,
    maxAdjudicationRounds: 1,
    verifyReserveFraction: 0.2,
    verifierFetch: false,
    verifierMaxTurns: 6,
    panelModelRole: "verify",
    panelGrantUSD: 0.04,
    leadContextTokens: 80_000,
    maxLeadSessions: 4,
    digestClaims: 30,
    maxConflictClaims: 150,
    maxConflictPairs: 60,
  },
  balanced: {
    budgetUSD: 2.5,
    depthCap: 2,
    breadthCap: 4,
    maxSources: 40,
    maxTokens: 20_000_000,
    maxAgents: 80,
    minFacets: 3,
    maxTurns: 60,
    maxSubagentTurns: 30,
    maxEntailmentChecks: 60,
    maxReportTokens: 8_192,
    maxReportCandidates: 20,
    maxReportClaims: 60,
    maxClaimsPerSource: 6,
    maxExtractionChars: 60_000,
    maxAdjudicationRounds: 1,
    verifyReserveFraction: 0.2,
    verifierFetch: false,
    verifierMaxTurns: 6,
    panelModelRole: "verify",
    panelGrantUSD: 0.04,
    leadContextTokens: 80_000,
    maxLeadSessions: 6,
    digestClaims: 60,
    maxConflictClaims: 400,
    maxConflictPairs: 150,
  },
  deep: {
    budgetUSD: 10,
    depthCap: 3,
    breadthCap: 8,
    maxSources: 100,
    maxTokens: 80_000_000,
    maxAgents: 250,
    minFacets: 4,
    maxTurns: 100,
    maxSubagentTurns: 50,
    maxEntailmentChecks: 150,
    maxReportTokens: 16_384,
    maxReportCandidates: 40,
    maxReportClaims: 120,
    maxClaimsPerSource: 8,
    maxExtractionChars: 100_000,
    maxAdjudicationRounds: 2,
    verifyReserveFraction: 0.25,
    verifierFetch: false,
    verifierMaxTurns: 8,
    panelModelRole: "lead",
    panelGrantUSD: 0.35,
    leadContextTokens: 120_000,
    maxLeadSessions: 8,
    digestClaims: 90,
    maxConflictClaims: 800,
    maxConflictPairs: 300,
  },
  max: {
    budgetUSD: 40,
    depthCap: 4,
    breadthCap: 12,
    maxSources: 250,
    maxTokens: 250_000_000,
    maxAgents: 800,
    minFacets: 5,
    maxTurns: 150,
    maxSubagentTurns: 75,
    maxEntailmentChecks: 400,
    maxReportTokens: 24_576,
    maxReportCandidates: 60,
    maxReportClaims: 160,
    maxClaimsPerSource: 10,
    maxExtractionChars: 150_000,
    maxAdjudicationRounds: 3,
    verifyReserveFraction: 0.3,
    verifierFetch: true,
    verifierMaxTurns: 12,
    panelModelRole: "lead",
    panelGrantUSD: 0.8,
    leadContextTokens: 160_000,
    maxLeadSessions: 12,
    digestClaims: 120,
    maxConflictClaims: 1_500,
    maxConflictPairs: 600,
  },
};
for (const envelope of Object.values(EFFORT_ENVELOPES)) {
  Object.freeze(envelope);
}
Object.freeze(EFFORT_ENVELOPES);

export interface Budget {
  maxUSD?: number;
  maxTokens?: number;
  maxAgents?: number;
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

export interface ConcurrencyConfig {
  models?: number;
  io?: number;
}

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
  concurrency?: ConcurrencyConfig;
  trace?: TraceMode;
}

export interface ResearchOptions {
  effort?: Effort;
  budget?: Budget;
  output?: OutputSpec;
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
  maxAgents: number;
  maxDurationMs?: number | undefined;
  maxSources: number;
  models: Record<ModelRole, ResolvedModel>;
  modelFallbackRoles: ModelRole[];
  leadModelId: string;
  pricing: PricingTable;
  safety: SafetyPolicy;
  sourceFilter?: SourceFilter | undefined;
  instructions?: string | undefined;
  output: OutputSpec;
  maxConcurrentModelCalls: number;
  maxConcurrentIo: number;
  trace: TraceMode;
}

const DEFAULT_MODEL_CONCURRENCY = 8;
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
  const maxAgentsRaw = budget.maxAgents ?? envelope.maxAgents;
  if (!Number.isFinite(maxAgentsRaw) || maxAgentsRaw < 1) {
    throw new ConfigError(`budget.maxAgents must be >= 1 (got ${maxAgentsRaw})`);
  }
  const maxAgents = Math.floor(maxAgentsRaw);
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
  const leadModelId = (lead as LanguageModelV3).modelId ?? "";
  const modelFallbackRoles: ModelRole[] = [];
  if (!derived && !isSmallModelId(leadModelId)) {
    if (!config.models?.extract) modelFallbackRoles.push("extract");
    if (!config.models?.verify) modelFallbackRoles.push("verify");
  }
  return {
    effort,
    envelope,
    budgetUSD,
    maxTokens,
    maxAgents,
    maxDurationMs: budget.maxDurationMs,
    maxSources: budget.maxSources ?? envelope.maxSources,
    models,
    modelFallbackRoles,
    leadModelId,
    pricing: config.pricing ?? {},
    safety: config.safety ?? {},
    sourceFilter: options.sources,
    instructions: config.instructions,
    output: options.output ?? { kind: "report" },
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
  };
}
