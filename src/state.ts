import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ConcurrencyGate } from "./async.js";
import type { BudgetGrant, BudgetMeter, PricingTable } from "./budget.js";
import type { Checklist } from "./checklist.js";
import type { ResolvedRunConfig } from "./config.js";
import type { ResearchEvent } from "./events.js";
import type { Ledger } from "./ledger.js";
import type { ModelRole, ResolvedModel, RunUsage } from "./model.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { MergedSearchResult, ResolvedSearch } from "./providers/search.js";
import type { JournalWriter, ReplayCache } from "./providers/store.js";
import type { ResolvedCustomTool } from "./custom-tools.js";
import type { FetchedSource, SourceDocument } from "./sources.js";
import type { TraceRecorder } from "./trace.js";
import type { Trail } from "./trail.js";

export interface SearchCacheEntry {
  merged: MergedSearchResult[];
  warnings: string[];
}

export interface OaCandidate {
  openUrls: string[];
  title?: string;
  fallbackText?: string;
}

export interface SurfacedCandidate {
  url: string;
  title: string;
  snippet: string;
}

export interface SourceStore {
  fetchedSources: FetchedSource[];
  byUrl: Map<string, SourceDocument>;
  byId: Map<string, SourceDocument>;
  reservedUrls: Set<string>;
  reservedSlots: number;
  nextSourceNumber: number;
  inFlight: Map<string, Promise<SourceDocument | null>>;
  searchCache: Map<string, Promise<SearchCacheEntry>>;
}

export function createSourceStore(): SourceStore {
  return {
    fetchedSources: [],
    byUrl: new Map(),
    byId: new Map(),
    reservedUrls: new Set(),
    reservedSlots: 0,
    nextSourceNumber: 1,
    inFlight: new Map(),
    searchCache: new Map(),
  };
}

export interface RunCounters {
  searches: number;
  searchCacheHits: number;
  modelCacheHits: number;
  modelGatePeakWidth: number;
  sourcesFetched: number;
  sourcesFailed: number;
  agentsSpawned: number;
  researchSpawned: number;
  researchSpawnsBlocked: number;
  researchInFlight: number;
  maxDepth: number;
  claimsVerified: number;
  coverageAnswered: boolean;
}

export function createRunCounters(): RunCounters {
  return {
    searches: 0,
    searchCacheHits: 0,
    modelCacheHits: 0,
    modelGatePeakWidth: 0,
    sourcesFetched: 0,
    sourcesFailed: 0,
    agentsSpawned: 0,
    researchSpawned: 0,
    researchSpawnsBlocked: 0,
    researchInFlight: 0,
    maxDepth: 0,
    claimsVerified: 0,
    coverageAnswered: false,
  };
}

export interface VerifySpawnArgs {
  claimIds: string[];
  lenses?: string[] | undefined;
  grant: BudgetGrant;
  parentId?: string | undefined;
  depth: number;
}

export interface VerifyScheduleArgs {
  claimIds: string[];
  reserve: BudgetGrant;
  perClaimFraction: number;
  concurrency: number;
  cap?: number | undefined;
  lenses?: string[] | undefined;
  parentId?: string | undefined;
  depth?: number | undefined;
}

export interface VerifySpawnVerdict {
  claimId: string;
  status: string;
  votes: string;
}

export interface VerifySpawnOutcome {
  verdicts: VerifySpawnVerdict[];
  note: string;
}

export interface RunCtx {
  runId: string;
  question: string;
  todayISO: string;
  config: ResolvedRunConfig;
  meter: BudgetMeter;
  verifyReserve: BudgetGrant;
  usage: RunUsage;
  pricing: PricingTable;
  ledger: Ledger;
  checklist: Checklist | null;
  trail: Trail;
  notes: string[];
  readCounts: Map<string, number>;
  sources: SourceStore;
  search: ResolvedSearch;
  searchBySource: Map<string, ResolvedSearch>;
  oaCandidates: Map<string, OaCandidate>;
  surfacedCandidates: Map<string, SurfacedCandidate>;
  fetchChain: FetchProvider[];
  customTools: ReadonlyMap<string, ResolvedCustomTool>;
  runCodeEnabled: boolean;
  emit(event: ResearchEvent): void;
  journal?: JournalWriter | undefined;
  replay?: ReplayCache | undefined;
  recorder?: TraceRecorder | undefined;
  signal?: AbortSignal | undefined;
  stopSignal?: AbortSignal | undefined;
  deadlineAt?: number | undefined;
  now(): number;
  modelGate: ConcurrencyGate;
  ioGate: ConcurrencyGate;
  seenDomains: Set<string>;
  verifyInFlight: Map<string, Promise<void>>;
  counters: RunCounters;
  agentSequence: { next: number };
  bindModel(role: ModelRole, grant: BudgetGrant): LanguageModelV3;
  rawModel(role: ModelRole): ResolvedModel;
  verify(args: VerifyScheduleArgs): Promise<VerifySpawnOutcome>;
  stopReason(): string | null;
}

export function budgetStatusLine(rctx: RunCtx): string {
  const spent = rctx.meter.totalSpentUSD();
  const total = rctx.meter.totalUSD;
  return `budget: ≈$${Math.max(0, total - spent).toFixed(2)} of $${total.toFixed(2)} remaining`;
}
