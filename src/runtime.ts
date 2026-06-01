import type Steel from "steel-sdk";
import type { ModelAdapter } from "./model.js";
import type { ResearchEffort } from "./defaults.js";
import type { Engine, WebSearchOutcome } from "./search.js";
import type { SearchProvider } from "./search-provider.js";
import type {
  FetchedSource,
  SourceDocument,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
import type { BrowserSessionPool } from "./browser-session-pool.js";
import type { BrowserSessionLease } from "./browser-session-pool.js";

export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SourceReservations {
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

export interface ResearchCaches {
  serp: Map<string, Promise<WebSearchOutcome>>;
  sources: Map<string, Promise<SourceCacheEntry>>;
  summaries: Map<string, Promise<string>>;
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

export function createResearchCaches(): ResearchCaches {
  return {
    serp: new Map<string, Promise<WebSearchOutcome>>(),
    sources: new Map<string, Promise<SourceCacheEntry>>(),
    summaries: new Map<string, Promise<string>>(),
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
  readonly defaultEngine: Engine;
  readonly useProxy: boolean;
  readonly sourceCap: number;
  readonly maxOutputTokens?: number;
  readonly defaultSearchLimit?: number;
  readonly maxConcurrentTools?: number;
  readonly fetchSnippetChars?: number;
  readonly subagentCompactionTriggerTokens?: number;
  readonly subagentCompactionKeepTokens?: number;
  readonly tokenLimit?: number;
  readonly maxDelegationDepth?: number;
  readonly maxConcurrentSubagents?: number;
  readonly subagentEffort?: ResearchEffort;
}

export interface ResearchDeps {
  model: ModelAdapter;
  summaryModel?: ModelAdapter;
  steel: Steel;
  signal?: AbortSignal;
  abort: () => void;
  searchProvider?: SearchProvider;
  /** Bounds concurrent Steel/network requests (web search + browser fetch). */
  ioGate: ConcurrencyGate;
  browserSessionPool?: BrowserSessionPool;
}

export interface SourceStore {
  fetchedSources: FetchedSource[];
  sourceDocuments: Map<string, SourceDocument>;
  sourceReservations: SourceReservations;
  caches: ResearchCaches;
}

export interface AgentScopeOverrides {
  query?: string;
  depth?: number;
  deadlineAt?: number;
  synthesisReserveMs?: number;
  compactionTriggerTokens?: number;
  compactionKeepTokens?: number;
}

export interface AgentScopeInit extends AgentScopeOverrides {
  sink: (event: ResearchLoopEvent) => void;
}

export interface AgentScope extends AsyncDisposable {
  query?: string;
  depth: number;
  deadlineAt?: number;
  synthesisReserveMs?: number;
  compactionTriggerTokens?: number;
  compactionKeepTokens?: number;
  browserSessionLease?: BrowserSessionLease;
  emit(event: ResearchLoopEvent): void;
  derive(overrides: AgentScopeOverrides): AgentScope;
}

export interface ResearchCtx {
  config: ResearchConfig;
  deps: ResearchDeps;
  store: SourceStore;
  scope: AgentScope;
}

export function createAgentScope(init: AgentScopeInit): AgentScope {
  const sink = init.sink;
  const scope: AgentScope = {
    query: init.query,
    depth: init.depth ?? 0,
    deadlineAt: init.deadlineAt,
    synthesisReserveMs: init.synthesisReserveMs,
    compactionTriggerTokens: init.compactionTriggerTokens,
    compactionKeepTokens: init.compactionKeepTokens,
    browserSessionLease: undefined,
    emit(event) {
      sink(
        scope.depth > 0 && event.depth === undefined
          ? { ...event, depth: scope.depth }
          : event,
      );
    },
    derive(overrides) {
      return createAgentScope({
        sink,
        query: overrides.query ?? scope.query,
        depth: overrides.depth ?? scope.depth,
        deadlineAt: overrides.deadlineAt ?? scope.deadlineAt,
        synthesisReserveMs:
          overrides.synthesisReserveMs ?? scope.synthesisReserveMs,
        compactionTriggerTokens:
          overrides.compactionTriggerTokens ?? scope.compactionTriggerTokens,
        compactionKeepTokens:
          overrides.compactionKeepTokens ?? scope.compactionKeepTokens,
      });
    },
    async [Symbol.asyncDispose]() {
      const lease = scope.browserSessionLease;
      scope.browserSessionLease = undefined;
      await lease?.release();
    },
  };
  return scope;
}

export type ResearchLoopEvent = (
  | { type: "research_started" }
  | {
      type: "searching";
      index: number;
      query: string;
    }
  | {
      type: "search_results";
      index: number;
      count: number;
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
  | { type: "research_finished"; sourcesFetched: number }
  | {
      type: "context_compacted";
      tokensBefore: number;
      tokensAfter: number;
      foldedMessages: number;
    }
  | { type: "delegation_started"; tasks: string[] }
  | { type: "subagent_started"; task: string }
  | {
      type: "subagent_finished";
      task: string;
      sourcesFetched: number;
      toolCalls: number;
      finishReason: string;
    }
) & {
  depth?: number;
};
