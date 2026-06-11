import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ConcurrencyGate } from "./async.js";
import type { BudgetGrant, BudgetMeter, PricingTable } from "./budget.js";
import type { ResolvedRunConfig } from "./config.js";
import type { ResearchEvent } from "./events.js";
import type { Ledger } from "./ledger.js";
import type { ModelRole, ResolvedModel, RunUsage } from "./model.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { ResolvedSearch } from "./providers/search.js";
import type { JournalWriter, ReplayCache } from "./providers/store.js";
import type { ResolvedCustomTool } from "./custom-tools.js";
import type { FetchedSource, SourceDocument } from "./sources.js";

export interface SourceStore {
  fetchedSources: FetchedSource[];
  byUrl: Map<string, SourceDocument>;
  byId: Map<string, SourceDocument>;
  reservedUrls: Set<string>;
  reservedSlots: number;
  nextSourceNumber: number;
  inFlight: Map<string, Promise<SourceDocument | null>>;
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
  };
}

export interface RunCounters {
  searches: number;
  sourcesFetched: number;
  sourcesFailed: number;
  agentsSpawned: number;
  maxDepth: number;
  claimsVerified: number;
}

export function createRunCounters(): RunCounters {
  return {
    searches: 0,
    sourcesFetched: 0,
    sourcesFailed: 0,
    agentsSpawned: 0,
    maxDepth: 0,
    claimsVerified: 0,
  };
}

export interface VerifySpawnArgs {
  claimIds: string[];
  lenses?: string[] | undefined;
  grant: BudgetGrant;
  parentId?: string | undefined;
  depth: number;
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
  config: ResolvedRunConfig;
  meter: BudgetMeter;
  verifyReserve: BudgetGrant;
  usage: RunUsage;
  pricing: PricingTable;
  ledger: Ledger;
  sources: SourceStore;
  search: ResolvedSearch;
  fetchChain: FetchProvider[];
  customTools: ReadonlyMap<string, ResolvedCustomTool>;
  emit(event: ResearchEvent): void;
  journal?: JournalWriter | undefined;
  replay?: ReplayCache | undefined;
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
  verifySpawn(args: VerifySpawnArgs): Promise<VerifySpawnOutcome>;
  stopReason(): string | null;
}

export function budgetStatusLine(rctx: RunCtx): string {
  const spent = rctx.meter.totalSpentUSD();
  const total = rctx.meter.totalUSD;
  return `budget: ≈$${(total - spent).toFixed(2)} of $${total.toFixed(2)} remaining`;
}
