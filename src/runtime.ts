import type Steel from "steel-sdk";
import type { ModelAdapter } from "./model.js";
import type { Engine, WebSearchOutcome } from "./search.js";
import type {
  FetchedSource,
  SourceDocument,
  SourceExtractionMetadata,
} from "./sources.js";

export interface SteelConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SourceReservations {
  urls: Set<string>;
  sourceSlots: number;
  nextSourceNumber: number;
  documents: Map<string, Promise<SourceDocument | null>>;
}

export interface ScrapeCacheEntry {
  markdown: string;
  title: string | null;
  metadata: SourceExtractionMetadata;
}

export interface ResearchCaches {
  serp: Map<string, Promise<WebSearchOutcome>>;
  scrape: Map<string, Promise<ScrapeCacheEntry>>;
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

export function createSteelConcurrencyGate(limit: number): SteelConcurrencyGate {
  const normalized = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
  return new Semaphore(normalized);
}

export function createResearchCaches(): ResearchCaches {
  return {
    serp: new Map<string, Promise<WebSearchOutcome>>(),
    scrape: new Map<string, Promise<ScrapeCacheEntry>>(),
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
  steel: Steel;
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
  steelConcurrencyGate: SteelConcurrencyGate;
  sourceReservations: SourceReservations;
  caches: ResearchCaches;
}

export type ResearchLoopEvent =
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
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "research_finished"; sourcesFetched: number };
