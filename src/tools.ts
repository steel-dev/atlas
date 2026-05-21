import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { FAST_MODEL, type CitedSource } from "./pipeline.js";
import {
  ENGINES,
  webSearch,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";

const STORED_MARKDOWN_CAP = 50_000;
const FETCH_SNIPPET_CHARS = 2500;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
]);

export interface SteelGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SourceReservations {
  urls: Set<string>;
  sourceSlots: number;
}

interface ScrapeCacheEntry {
  markdown: string;
  title: string | null;
}

export interface ResearchCaches {
  serp: Map<string, Promise<WebSearchOutcome>>;
  scrape: Map<string, Promise<ScrapeCacheEntry>>;
}

class Semaphore implements SteelGate {
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

export function createSteelGate(limit: number): SteelGate {
  const normalized = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
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
  };
}

// ----------------------------------------------------------------------------
// Agentic gather loop
//
// A single Haiku-driven gather loop gets two tools:
//   - search(query, limit?)
//   - fetch(url) — scrape + atomic commit to global pool
//
// The agent terminates by calling done, emitting a final text message with no
// tool calls, or hitting its tool/source budget. Every successful fetch commits
// the page to the pool — choose carefully.
//
// Global invariants (URL dedup, source cap) are enforced
// INSIDE the tools, so the agent can't break them no matter what it picks.
// ----------------------------------------------------------------------------

export interface AgentContext {
  anthropic: Anthropic;
  steel: Steel;
  sources: CitedSource[];
  sourceUrls: Set<string>;
  sourceMarkdowns: Map<number, string>;
  emit: (e: AgenticEvent) => void;
  abort: () => void;
  /** Forwarded to every Anthropic / Steel / fetch call so cancellation
   *  interrupts in-flight requests, not just step boundaries. */
  signal?: AbortSignal;
  defaultEngine: Engine;
  useProxy: boolean;
  fastModel?: string;
  globalSourceCap: number;
  maxConcurrentTools?: number;
  steelGate: SteelGate;
  sourceReservations: SourceReservations;
  caches: ResearchCaches;
}

// A loose superset of the research event types this module emits. Kept here
// to avoid importing from research.ts (which would create a cycle).
export type AgenticEvent =
  | { type: "agent_started" }
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
      type: "source_committed";
      url: string;
      n: number;
      title: string;
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "agent_finished"; sources_added: number };

export interface AgenticRunResult {
  source_ns: number[];
  tool_calls: number;
  finish_reason: string;
}

interface SearchToolInput {
  query?: string;
  limit?: number;
}
interface FetchToolInput {
  url?: string;
}

interface EngineSearchOutcome {
  engine: Engine;
  outcome?: WebSearchOutcome;
  error?: string;
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search the web for sources addressing the question. Prefer short, specific queries. Use site: filters directly in the query when useful.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Short, search-engine-friendly query (≤10 words ideal).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "How many results to request from each search provider. Default 5.",
        },
      },
      required: ["query"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "fetch",
    description:
      "Fetch a URL, atomically commit it to the global source pool, and return the assigned [n] plus the first chars of the page so you can decide whether to chase citations or pivot. " +
      "Every successful fetch commits — pick the 2-4 most promising results per search, not all of them. Off-topic fetches waste your source budget.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to fetch.",
        },
      },
      required: ["url"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "done",
    description:
      "Call when the source pool covers the question well enough for the writer.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    } as Anthropic.Tool["input_schema"],
  },
];

const AGENT_SYSTEM = `You're a research agent. Use search and fetch to gather high-quality sources for the user's question, then call done. Every fetch commits — choose carefully. Prefer primary sources and diverse independent evidence.`;

function totalSourceSlots(ctx: AgentContext): number {
  return ctx.sources.length + ctx.sourceReservations.sourceSlots;
}

function normalizeFetchUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lower)) {
        u.searchParams.delete(key);
      }
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}

function searchCacheKey(opts: {
  query: string;
  limit: number;
  engine: Engine;
  useProxy: boolean;
}): string {
  return [
    "web",
    opts.engine,
    opts.useProxy ? "proxy" : "direct",
    opts.limit,
    opts.query,
  ].join("\0");
}

function searchEnginesInFallbackOrder(defaultEngine: Engine): Engine[] {
  return [
    defaultEngine,
    ...ENGINES.filter((engine) => engine !== defaultEngine),
  ];
}

async function searchWithCache(
  ctx: AgentContext,
  opts: { query: string; limit: number; engine: Engine },
): Promise<WebSearchOutcome> {
  const cacheKey = searchCacheKey({
    query: opts.query,
    limit: opts.limit,
    engine: opts.engine,
    useProxy: ctx.useProxy,
  });
  let outcomePromise = ctx.caches.serp.get(cacheKey);
  if (!outcomePromise) {
    outcomePromise = ctx.steelGate.run(() =>
      webSearch({
        steel: ctx.steel,
        query: opts.query,
        engine: opts.engine,
        useProxy: ctx.useProxy,
        limit: opts.limit,
        signal: ctx.signal,
      }),
    );
    ctx.caches.serp.set(cacheKey, outcomePromise);
  }

  try {
    return await outcomePromise;
  } catch (err) {
    ctx.caches.serp.delete(cacheKey);
    throw err;
  }
}

function mergeSearchResults(engineOutcomes: EngineSearchOutcome[]): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const engineOutcome of engineOutcomes) {
    if (!engineOutcome.outcome?.ok) continue;
    for (const result of engineOutcome.outcome.results) {
      const urlKey = normalizeFetchUrl(result.url);
      if (seenUrls.has(urlKey)) continue;
      seenUrls.add(urlKey);
      results.push({ ...result, position: results.length + 1 });
    }
  }

  return results;
}

interface FetchReservation {
  url: string;
}

function reserveFetch(ctx: AgentContext, url: string): FetchReservation | string {
  const normalizedUrl = normalizeFetchUrl(url);
  if (ctx.sourceUrls.has(normalizedUrl)) {
    const existing = ctx.sources.find((s) => normalizeFetchUrl(s.url) === normalizedUrl);
    return `Already in source pool as [${existing?.n ?? "?"}]: ${existing?.title ?? url}. Pick a different result.`;
  }
  if (ctx.sourceReservations.urls.has(normalizedUrl)) {
    return `Already being fetched: ${url}. Pick a different result.`;
  }

  if (totalSourceSlots(ctx) >= ctx.globalSourceCap) {
    return `Global source cap reached (${ctx.globalSourceCap}). Stop fetching.`;
  }

  ctx.sourceReservations.urls.add(normalizedUrl);
  ctx.sourceReservations.sourceSlots++;
  return { url: normalizedUrl };
}

function releaseFetchReservation(
  ctx: AgentContext,
  reservation: FetchReservation,
): void {
  ctx.sourceReservations.urls.delete(reservation.url);
  ctx.sourceReservations.sourceSlots = Math.max(
    0,
    ctx.sourceReservations.sourceSlots - 1,
  );
}

async function execSearch(
  args: SearchToolInput,
  ctx: AgentContext,
  searchIndex: number,
): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: search requires a non-empty `query`.";

  const rawLimit = args.limit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 10);

  ctx.emit({
    type: "searching",
    index: searchIndex,
    query,
  });

  const engineOutcomes: EngineSearchOutcome[] = await Promise.all(
    searchEnginesInFallbackOrder(ctx.defaultEngine).map(async (engine) => {
      try {
        return {
          engine,
          outcome: await searchWithCache(ctx, { query, limit, engine }),
        };
      } catch (err) {
        return {
          engine,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const failures = engineOutcomes.flatMap((engineOutcome) => {
    if (engineOutcome.error) {
      return [`${engineOutcome.engine}: ${engineOutcome.error}`];
    }
    if (engineOutcome.outcome && !engineOutcome.outcome.ok) {
      return [`${engineOutcome.engine}: ${engineOutcome.outcome.error.message}`];
    }
    return [];
  });
  const successfulEngines = engineOutcomes
    .filter((engineOutcome) => engineOutcome.outcome?.ok)
    .map((engineOutcome) => engineOutcome.engine);
  const results = mergeSearchResults(engineOutcomes);

  if (successfulEngines.length === 0) {
    const error = failures.join("; ") || "all engines failed";
    ctx.emit({
      type: "search_failed",
      index: searchIndex,
      error,
    });
    return `Search failed: ${error}`;
  }

  ctx.emit({
    type: "search_results",
    index: searchIndex,
    count: results.length,
  });

  if (results.length === 0) {
    return "No results for this query.";
  }
  const lines = results.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : ""}`,
  );
  const engineNote = ` from ${successfulEngines.join(", ")}`;
  return `${results.length} merged result${results.length === 1 ? "" : "s"}${engineNote}:\n\n${lines.join("\n\n")}`;
}

interface FetchOutcome {
  text: string;
  committed_n?: number;
}

interface ToolExecution {
  toolResult: Anthropic.ToolResultBlockParam;
  committed_n?: number;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(normalizedLimit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function executeToolUse(
  tu: Anthropic.ToolUseBlock,
  ctx: AgentContext,
  searchIndex?: number,
): Promise<ToolExecution> {
  if (tu.name === "search") {
    try {
      const text = await execSearch(
        (tu.input as SearchToolInput) ?? {},
        ctx,
        searchIndex ?? 0,
      );
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: text,
        },
      };
    } catch (err) {
      ctx.abort();
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        },
      };
    }
  }

  if (tu.name === "fetch") {
    try {
      const out = await execFetch((tu.input as FetchToolInput) ?? {}, ctx);
      return {
        committed_n: out.committed_n,
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: out.text,
        },
      };
    } catch (err) {
      ctx.abort();
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        },
      };
    }
  }

  if (tu.name === "done") {
    return {
      toolResult: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: "Done.",
      },
    };
  }

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: tu.id,
      content: `Unknown tool: ${tu.name}`,
      is_error: true,
    },
  };
}

async function execFetch(
  args: FetchToolInput,
  ctx: AgentContext,
): Promise<FetchOutcome> {
  const requestedUrl = String(args.url ?? "").trim();
  if (!requestedUrl) return { text: "Error: fetch requires a `url`." };
  if (!/^https?:\/\//i.test(requestedUrl)) {
    return { text: `Error: not an http(s) URL: ${requestedUrl}` };
  }

  const reservation = reserveFetch(ctx, requestedUrl);
  if (typeof reservation === "string") return { text: reservation };
  const url = reservation.url;

  ctx.emit({ type: "fetching", url });

  try {
    let scrapePromise = ctx.caches.scrape.get(url);
    if (!scrapePromise) {
      scrapePromise = ctx.steelGate
        .run(() =>
          ctx.steel.scrape(
            {
              url,
              format: ["markdown"],
              useProxy: ctx.useProxy,
            },
            { signal: ctx.signal },
          ),
        )
        .then((scrape) => ({
          markdown: scrape.content?.markdown ?? "",
          title: scrape.metadata?.title ?? null,
        }));
      ctx.caches.scrape.set(url, scrapePromise);
    }

    const { markdown, title } = await scrapePromise;
    if (!markdown) {
      ctx.caches.scrape.delete(url);
      ctx.emit({
        type: "source_error",
        url,
        error: "Empty markdown",
      });
      return { text: `Empty page (no content fetched).` };
    }

    ctx.abort();

    // Commit while the reservation is still held so source numbers and caps stay
    // consistent across parallel tool calls.
    const n = ctx.sources.length + 1;
    const resolvedTitle = title ?? url;
    ctx.sources.push({
      n,
      url,
      title: resolvedTitle,
    });
    ctx.sourceUrls.add(url);
    ctx.sourceMarkdowns.set(n, markdown.slice(0, STORED_MARKDOWN_CAP));

    ctx.emit({
      type: "source_committed",
      url,
      n,
      title: resolvedTitle,
    });

    const snippet = markdown.slice(0, FETCH_SNIPPET_CHARS).trim();
    return {
      committed_n: n,
      text: `Committed [${n}]: ${resolvedTitle}\nURL: ${url}\nFirst ${FETCH_SNIPPET_CHARS} chars:\n${snippet}`,
    };
  } catch (err) {
    ctx.caches.scrape.delete(url);
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({
      type: "source_error",
      url,
      error: message,
    });
    return { text: `Fetch error: ${message}` };
  } finally {
    releaseFetchReservation(ctx, reservation);
  }
}

export async function runGatherAgent(opts: {
  ctx: AgentContext;
  query: string;
  max_tool_calls?: number;
}): Promise<AgenticRunResult> {
  const { ctx, query } = opts;
  const maxToolCalls = opts.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;

  ctx.emit({ type: "agent_started" });

  const myAddedNs: number[] = [];
  let toolCalls = 0;
  let finishReason = "tool call budget exhausted";
  let searchIndex = 0;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Research question: ${query}\n\n` +
        `Budget: at most ${maxToolCalls} tool calls and ${ctx.globalSourceCap} sources committed.\n` +
        `Begin.`,
    },
  ];

  while (toolCalls < maxToolCalls && ctx.sources.length < ctx.globalSourceCap) {
    ctx.abort();

    let resp: Anthropic.Message;
    try {
      resp = await ctx.anthropic.messages.create(
        {
          model: ctx.fastModel ?? FAST_MODEL,
          max_tokens: 2048,
          system: AGENT_SYSTEM,
          tools: AGENT_TOOLS,
          messages,
          cache_control: { type: "ephemeral" },
        },
        { signal: ctx.signal },
      );
    } catch (err) {
      // SDK abort errors wrap the AbortSignal as APIUserAbortError (name
      // defaults to "Error"), so check the signal directly.
      if (ctx.signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      finishReason = `api error: ${message}`;
      break;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );
    if (toolUses.length === 0) {
      finishReason = "agent stopped emitting tools";
      break;
    }

    if (toolUses.some((tu) => tu.name === "done")) {
      finishReason = "done";
      toolCalls += 1;
      break;
    }

    const remainingToolCalls = maxToolCalls - toolCalls;
    const activeToolUses = toolUses.slice(0, remainingToolCalls);
    const searchIndexes = activeToolUses.map((tu) =>
      tu.name === "search" ? ++searchIndex : undefined,
    );
    toolCalls += activeToolUses.length;

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) =>
        executeToolUse(
          tu,
          ctx,
          searchIndexes[index],
        ),
    );
    const toolResults = executions.map((e) => e.toolResult);
    for (const execution of executions) {
      if (execution.committed_n !== undefined) {
        myAddedNs.push(execution.committed_n);
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (ctx.sources.length >= ctx.globalSourceCap) {
      finishReason = "source cap reached";
      break;
    }
    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  ctx.emit({
    type: "agent_finished",
    sources_added: myAddedNs.length,
  });

  return {
    source_ns: [...myAddedNs],
    tool_calls: toolCalls,
    finish_reason: finishReason,
  };
}
