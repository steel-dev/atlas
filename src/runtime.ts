import type Steel from "steel-sdk";
import type { ModelAdapter } from "./model.js";
import type { ResearchEffort } from "./defaults.js";
import type { Engine, WebSearchOutcome } from "./search.js";
import type {
  FetchedSource,
  SourceDocument,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
import type { BrowserSessionPool } from "./browser-session-pool.js";
import type { BrowserSessionLease } from "./browser-session-pool.js";

export interface SteelConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SourceReservations {
  urls: Set<string>;
  sourceSlots: number;
  nextSourceNumber: number;
  documents: Map<string, Promise<SourceDocument | null>>;
}

export interface BudgetLedger {
  remainingActionCalls: number;
  remainingToolExecutions: number;
  consume(actionCalls: number, toolExecutions: number): void;
}

export function createBudgetLedger(
  maxActionCalls: number,
  maxToolExecutions: number,
): BudgetLedger {
  const clampInit = (n: number) =>
    Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return {
    remainingActionCalls: clampInit(maxActionCalls),
    remainingToolExecutions: clampInit(maxToolExecutions),
    consume(actionCalls, toolExecutions) {
      this.remainingActionCalls = Math.max(
        0,
        this.remainingActionCalls - Math.max(0, Math.floor(actionCalls)),
      );
      this.remainingToolExecutions = Math.max(
        0,
        this.remainingToolExecutions - Math.max(0, Math.floor(toolExecutions)),
      );
    },
  };
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

class Semaphore implements SteelConcurrencyGate {
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

export function createSteelConcurrencyGate(
  limit: number,
): SteelConcurrencyGate {
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

export interface ResearchLoopContext {
  model: ModelAdapter;
  summaryModel?: ModelAdapter;
  steel: Steel;
  query?: string;
  fetchedSources: FetchedSource[];
  sourceDocuments: Map<string, SourceDocument>;
  emit: (e: ResearchLoopEvent) => void;
  abort: () => void;
  /** Forwarded to every model / Steel / HTTP call so cancellation
   *  interrupts in-flight requests, not just step boundaries. */
  signal?: AbortSignal;
  defaultEngine: Engine;
  useProxy: boolean;
  sourceCap: number;
  maxOutputTokens?: number;
  defaultSearchLimit?: number;
  maxConcurrentTools?: number;
  fetchSnippetChars?: number;
  deadlineAt?: number;
  synthesisReserveMs?: number;
  steelConcurrencyGate: SteelConcurrencyGate;
  browserSessionPool?: BrowserSessionPool;
  browserSessionLease?: BrowserSessionLease;
  sourceReservations: SourceReservations;
  caches: ResearchCaches;
  budget?: BudgetLedger;
  /** When the estimated transcript exceeds this many tokens, older turns are
   *  folded into a compact progress note before the next model step. Unset or
   *  <= 0 disables compaction. */
  compactionTriggerTokens?: number;
  /** Approximate size of the most recent turns kept verbatim after a
   *  compaction. Defaults to half the trigger. */
  compactionKeepTokens?: number;
  /** Compaction trigger applied to sub-agents (lower than the lead's, per the
   *  multi-agent system-card setting). Inherited by forked sub-agent contexts. */
  subagentCompactionTriggerTokens?: number;
  /** Verbatim tail size kept after a sub-agent compaction. */
  subagentCompactionKeepTokens?: number;
  /** Total token budget (test-time compute limit) shared across the lead and
   *  every sub-agent, metered against the shared model adapter usage. The loop
   *  stops starting new steps once this is exceeded. Unset or <= 0 = unlimited. */
  tokenLimit?: number;
  depth?: number;
  maxDelegationDepth?: number;
  maxConcurrentSubagents?: number;
  subagentGate?: SteelConcurrencyGate;
  subagentEffort?: ResearchEffort;
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
