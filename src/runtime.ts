import type Steel from "steel-sdk";
import {
  totalUsageTokens,
  type ModelAdapter,
  type ProviderOptions,
} from "./model.js";
import type { WebSearchOutcome } from "./search.js";
import type { SearchProvider } from "./search-provider.js";
import type {
  FetchedSource,
  SourceDocument,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
import type { BrowserSessionPool } from "./browser-session-pool.js";
import type { BrowserSessionLease } from "./browser-session-pool.js";
import type { ClaimLedger } from "./claims.js";
import type { ResolvedCustomTool } from "./custom-tools.js";

export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface AdaptiveConcurrencyGate extends ConcurrencyGate {
  throttle(): void;
  relax(): void;
  readonly limit: number;
}

interface SourceReservations {
  urls: Set<string>;
  sourceSlots: number;
  nextSourceNumber: number;
  documents: Map<string, Promise<SourceDocument | null>>;
}

export interface SourceCacheEntry {
  markdown: string;
  title: string | null;
  metadata: SourceExtractionMetadata;
}

interface ResearchCaches {
  serp: Map<string, Promise<WebSearchOutcome>>;
  sources: Map<string, Promise<SourceCacheEntry>>;
}

class Semaphore implements ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) =>
      this.waiting.push(() => {
        this.active++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const normalized = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
  return new Semaphore(normalized);
}

class AdaptiveSemaphore implements AdaptiveConcurrencyGate {
  private active = 0;
  private current: number;
  private readonly ceiling: number;
  private cleanSuccesses = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(ceiling: number) {
    this.ceiling = Math.max(1, Math.floor(ceiling));
    this.current = this.ceiling;
  }

  get limit(): number {
    return this.current;
  }

  throttle(): void {
    this.current = Math.max(1, Math.floor(this.current / 2));
    this.cleanSuccesses = 0;
  }

  relax(): void {
    if (this.current >= this.ceiling) return;
    this.cleanSuccesses++;
    if (this.cleanSuccesses >= this.current) {
      this.current++;
      this.cleanSuccesses = 0;
      this.wake();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.current) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) =>
      this.waiting.push(() => {
        this.active++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.active--;
    this.wake();
  }

  private wake(): void {
    while (this.active < this.current && this.waiting.length > 0) {
      this.waiting.shift()?.();
    }
  }
}

export function createAdaptiveConcurrencyGate(
  ceiling: number,
): AdaptiveConcurrencyGate {
  const normalized = Number.isFinite(ceiling)
    ? Math.max(1, Math.floor(ceiling))
    : 1;
  return new AdaptiveSemaphore(normalized);
}

export function createResearchCaches(): ResearchCaches {
  return {
    serp: new Map<string, Promise<WebSearchOutcome>>(),
    sources: new Map<string, Promise<SourceCacheEntry>>(),
  };
}

export function createSourceReservations(): SourceReservations {
  return {
    urls: new Set<string>(),
    sourceSlots: 0,
    nextSourceNumber: 1,
    documents: new Map<string, Promise<SourceDocument | null>>(),
  };
}

export interface ResearchConfig {
  readonly useProxy: boolean;
  readonly sourceCap: number;
  readonly verifyTargetConfirmed?: number;
  readonly verifierPanel?: "lens" | "clone";
  /** Backstop on a single verifier voter's tool-using turns. Falls back to a
   *  generous default when unset; the per-vote token budget usually binds first. */
  readonly verifierMaxToolTurns?: number;
  /** Per-vote input-token budget that bounds how deep one voter investigates
   *  before it must decide. Falls back to a default when unset. */
  readonly verifierTokenBudget?: number;
  readonly maxOutputTokens?: number;
  readonly defaultSearchLimit?: number;
  readonly maxConcurrentTools?: number;
  readonly tokenLimit?: number;
  /** Estimated-token transcript size at which the lead loop re-anchors onto the
   *  ledger. Falls back to a context-safe default when unset. */
  readonly reanchorTokens?: number;
  readonly exploreProviderOptions?: ProviderOptions;
  readonly finalizeProviderOptions?: ProviderOptions;
  readonly instructions?: string;
}

interface ResearchDeps {
  model: ModelAdapter;
  leafModel?: ModelAdapter;
  steel: Steel;
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
  throwIfAborted: () => void;
  searchProvider?: SearchProvider;
  /** Bounds concurrent Steel/network requests (web search + browser fetch). */
  ioGate: ConcurrencyGate;
  browserSessionPool: BrowserSessionPool;
}

interface SourceStore {
  fetchedSources: FetchedSource[];
  sourceDocuments: Map<string, SourceDocument>;
  sourceDocumentsById: Map<string, SourceDocument>;
  sourceReservations: SourceReservations;
  caches: ResearchCaches;
  claims: ClaimLedger;
}

export function createSourceStore(claims: ClaimLedger): SourceStore {
  return {
    fetchedSources: [],
    sourceDocuments: new Map(),
    sourceDocumentsById: new Map(),
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
    claims,
  };
}

interface AgentScopeInit {
  sink: (event: ResearchLoopEvent) => void;
  query?: string;
  deadlineAt?: number;
  synthesisReserveMs?: number;
}

interface AgentScope extends AsyncDisposable {
  query?: string;
  deadlineAt?: number;
  synthesisReserveMs?: number;
  browserSessionLease?: BrowserSessionLease;
  emit(event: ResearchLoopEvent): void;
}

export interface ResearchCtx {
  config: ResearchConfig;
  deps: ResearchDeps;
  store: SourceStore;
  scope: AgentScope;
  tools?: ReadonlyMap<string, ResolvedCustomTool>;
}

function totalUsedTokens(deps: ResearchDeps): number {
  const lead = totalUsageTokens(deps.model.usage);
  const leaf = deps.leafModel;
  if (!leaf || leaf.usage === deps.model.usage) return lead;
  return lead + totalUsageTokens(leaf.usage);
}

export function tokenBudgetExhaustedReason(ctx: ResearchCtx): string | null {
  if (!ctx.config.tokenLimit || ctx.config.tokenLimit <= 0) return null;
  if (totalUsedTokens(ctx.deps) < ctx.config.tokenLimit) return null;
  return "token budget exhausted";
}

const VERIFY_BUDGET_RESERVE = 0.2;

export function researchBudgetExhaustedReason(ctx: ResearchCtx): string | null {
  const limit = ctx.config.tokenLimit;
  if (!limit || limit <= 0) return null;
  if (totalUsedTokens(ctx.deps) < limit * (1 - VERIFY_BUDGET_RESERVE)) {
    return null;
  }
  return "research budget exhausted";
}

export function stopRequestedReason(ctx: ResearchCtx): string | null {
  return ctx.deps.stopSignal?.aborted ? "stop requested" : null;
}

export function createAgentScope(init: AgentScopeInit): AgentScope {
  const sink = init.sink;
  const scope: AgentScope = {
    query: init.query,
    deadlineAt: init.deadlineAt,
    synthesisReserveMs: init.synthesisReserveMs,
    browserSessionLease: undefined,
    emit(event) {
      sink(event);
    },
    async [Symbol.asyncDispose]() {
      const lease = scope.browserSessionLease;
      scope.browserSessionLease = undefined;
      await lease?.release();
    },
  };
  return scope;
}

export function timeoutSynthesisReason(ctx: ResearchCtx): string | null {
  if (
    ctx.scope.deadlineAt === undefined ||
    ctx.scope.synthesisReserveMs === undefined
  ) {
    return null;
  }
  const remainingMs = ctx.scope.deadlineAt - Date.now();
  if (remainingMs > ctx.scope.synthesisReserveMs) return null;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `timeout approaching (${remainingSeconds}s remaining)`;
}

export type ResearchLoopEvent =
  | { type: "research_started" }
  | {
      type: "scope_completed";
      strategy: string;
      angles: Array<{ label: string; query: string }>;
    }
  | {
      type: "searching";
      index: number;
      query: string;
    }
  | {
      type: "search_results";
      index: number;
      count: number;
      results?: Array<{
        url: string;
        domain: string;
        title?: string;
        snippet?: string;
      }>;
    }
  | {
      type: "search_failed";
      index: number;
      error: string;
    }
  | { type: "fetching"; url: string }
  | {
      type: "rate_limited";
      retryAfterSeconds: number;
      attempt: number;
      maxAttempts: number;
    }
  | {
      type: "source_fetched";
      url: string;
      title: string;
      method?: string;
      markdownChars?: number;
      attempts?: SourceExtractionAttempt[];
      qualityWarnings?: string[];
    }
  | { type: "source_error"; url: string; error: string }
  | {
      type: "claims_extracted";
      sourceId: string;
      url: string;
      count: number;
      unsupported: number;
      error?: string;
    }
  | {
      type: "claims_clustered";
      clustersFormed: number;
      claimsDeduped: number;
    }
  | { type: "verify_started"; claims: number }
  | {
      type: "claim_verified";
      id: string;
      claim: string;
      vote: string;
      status: string;
    }
  | {
      type: "verify_finished";
      confirmed: number;
      refuted: number;
      unverified: number;
    }
  | { type: "research_finished"; sourcesFetched: number }
  | {
      type: "context_reanchored";
      tokensBefore: number;
      droppedMessages: number;
    }
  | { type: "report_boundary" }
  | { type: "report_delta"; text: string }
  | { type: "synthesis_failed"; reason: string; error?: string }
  | { type: "tool_event"; tool: string; data: unknown };
