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
import { fetchPlainPage } from "./plain-fetch.js";

const STORED_MARKDOWN_CAP = 120_000;
const FETCH_SNIPPET_CHARS = 2500;
const INSPECT_SNIPPET_CHARS = 4000;
const SEARCH_SNIPPET_CHARS = 500;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const STEEL_RATE_LIMIT_MAX_ATTEMPTS = 6;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 15;
type SearchMode = "fallback" | "aggregate";
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
// A single gather loop gets these tools:
//   - search(query, limit?)
//   - inspect(url) — scrape without committing
//   - fetch(url) — scrape + atomic commit to global pool
//
// The agent terminates by calling done, emitting a final text message with no
// tool calls, or hitting its tool/source budget. The agent can inspect freely
// before committing the strongest pages as cited sources.
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
  gatherMaxTokens?: number;
  searchMode?: SearchMode;
  defaultSearchLimit?: number;
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
  | { type: "inspecting"; url: string }
  | { type: "steel_fallback"; url: string; reason: string }
  | {
      type: "rate_limited";
      retry_after_seconds: number;
      attempt: number;
      max_attempts: number;
    }
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
interface UrlToolInput {
  url?: string;
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
          maximum: 20,
          description:
            "How many results to request from each search provider. Default depends on research depth.",
        },
      },
      required: ["query"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "inspect",
    description:
      "Fetch a URL without committing it as a cited source. Use this liberally to evaluate promising search results, follow references, and decide whether the page deserves source budget.",
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
    name: "fetch",
    description:
      "Commit a URL to the global cited source pool and return the assigned [n] plus the first chars of the page. Use after inspect, or directly when the URL is clearly a high-value primary source.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to commit as a source.",
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

const AGENT_SYSTEM = `You're a research agent. Use search, inspect, and fetch to gather high-quality sources for the user's question, then call done. Inspect promising pages before committing them when relevance is uncertain. Commit enough primary, recent, and independent sources to let the writer answer deeply. Prefer chasing citations and original documents over stopping at summaries.`;

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

function formatSearchResult(
  result: SearchResult,
  index: number,
  sourceLabel?: string,
): string {
  const label = sourceLabel ? ` (${sourceLabel})` : "";
  const snippet = result.snippet
    ? `\n   ${result.snippet.slice(0, SEARCH_SNIPPET_CHARS)}`
    : "";
  return `${index + 1}. ${result.title}${label}\n   ${result.url}${snippet}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => string | null }).get(name);
    return value ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function parseRetryAfterSeconds(err: unknown): number | null {
  const status = (err as { status?: number })?.status;
  const message = errorMessage(err);
  if (status !== 429 && !/(rate limit exceeded|too many requests)/i.test(message)) {
    return null;
  }

  const headerValue = readHeader((err as { headers?: unknown })?.headers, "retry-after");
  if (headerValue) {
    const numeric = Number(headerValue);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.ceil(numeric);
    }
    const dateMs = Date.parse(headerValue);
    if (Number.isFinite(dateMs)) {
      return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000));
    }
  }

  const messageMatch = /try again in\s+(\d+(?:\.\d+)?)\s*seconds?/i.exec(message);
  if (messageMatch) return Math.ceil(Number(messageMatch[1]));

  return DEFAULT_RATE_LIMIT_RETRY_SECONDS;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runSteelRequest<T>(
  ctx: AgentContext,
  request: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= STEEL_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      return await ctx.steelGate.run(request);
    } catch (err) {
      const retryAfterSeconds = parseRetryAfterSeconds(err);
      if (!retryAfterSeconds || attempt >= STEEL_RATE_LIMIT_MAX_ATTEMPTS) {
        throw err;
      }
      ctx.emit({
        type: "rate_limited",
        retry_after_seconds: retryAfterSeconds,
        attempt,
        max_attempts: STEEL_RATE_LIMIT_MAX_ATTEMPTS,
      });
      await delay((retryAfterSeconds + 1) * 1000, ctx.signal);
    }
  }

  throw new Error("unreachable Steel retry state");
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
    outcomePromise = runSteelRequest(ctx, () =>
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

async function execAggregateSearch(
  ctx: AgentContext,
  opts: { query: string; limit: number; searchIndex: number },
): Promise<string> {
  const outcomes = await Promise.all(
    searchEnginesInFallbackOrder(ctx.defaultEngine).map(async (engine) => {
      try {
        return {
          engine,
          outcome: await searchWithCache(ctx, {
            query: opts.query,
            limit: opts.limit,
            engine,
          }),
        };
      } catch (err) {
        return {
          engine,
          error: errorMessage(err),
        };
      }
    }),
  );

  const failures: string[] = [];
  const seenUrls = new Set<string>();
  const merged: Array<SearchResult & { engine: Engine }> = [];

  for (const item of outcomes) {
    if ("error" in item) {
      failures.push(`${item.engine}: ${item.error}`);
      continue;
    }
    if (!item.outcome.ok) {
      failures.push(`${item.engine}: ${item.outcome.error.message}`);
      continue;
    }
    for (const result of item.outcome.results) {
      const normalized = normalizeFetchUrl(result.url);
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      merged.push({ ...result, engine: item.engine });
    }
  }

  if (merged.length === 0) {
    const error = failures.join("; ") || "all engines returned no results";
    if (failures.length > 0) {
      ctx.emit({
        type: "search_failed",
        index: opts.searchIndex,
        error,
      });
    } else {
      ctx.emit({
        type: "search_results",
        index: opts.searchIndex,
        count: 0,
      });
    }
    return failures.length > 0
      ? `Search failed: ${error}`
      : "No results for this query from any engine.";
  }

  const results = merged.slice(0, opts.limit * ENGINES.length);
  ctx.emit({
    type: "search_results",
    index: opts.searchIndex,
    count: results.length,
  });

  const lines = results.map((result, index) =>
    formatSearchResult(result, index, result.engine),
  );
  const failureNote =
    failures.length > 0 ? `\n\nSome engines failed: ${failures.join("; ")}` : "";
  return `${results.length} deduped results from ${ENGINES.length} engines:\n\n${lines.join("\n\n")}${failureNote}`;
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

  const rawLimit = args.limit ?? ctx.defaultSearchLimit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 20);

  ctx.emit({
    type: "searching",
    index: searchIndex,
    query,
  });

  const failures: string[] = [];
  const emptyEngines: Engine[] = [];

  if (ctx.searchMode === "aggregate") {
    return execAggregateSearch(ctx, { query, limit, searchIndex });
  }

  for (const engine of searchEnginesInFallbackOrder(ctx.defaultEngine)) {
    let outcome: WebSearchOutcome;
    try {
      outcome = await searchWithCache(ctx, { query, limit, engine });
    } catch (err) {
      failures.push(`${engine}: ${errorMessage(err)}`);
      continue;
    }

    if (!outcome.ok) {
      failures.push(`${engine}: ${outcome.error.message}`);
      continue;
    }

    if (outcome.results.length === 0) {
      emptyEngines.push(engine);
      continue;
    }

    const results = outcome.results.map((result, index) => ({
      ...result,
      position: index + 1,
    }));

    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: results.length,
    });

    const lines = results.map((result, index) =>
      formatSearchResult(result, index),
    );
    const fallbackNote =
      engine === ctx.defaultEngine ? "" : ` after fallback from ${ctx.defaultEngine}`;
    return `${results.length} result${results.length === 1 ? "" : "s"} from ${engine}${fallbackNote}:\n\n${lines.join("\n\n")}`;
  }

  if (emptyEngines.length > 0) {
    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: 0,
    });
    const tried = emptyEngines.join(", ");
    return failures.length > 0
      ? `No results for this query from ${tried}. Other engines failed: ${failures.join("; ")}`
      : `No results for this query from ${tried}.`;
  }

  {
    const error = failures.join("; ") || "all engines failed";
    ctx.emit({
      type: "search_failed",
      index: searchIndex,
      error,
    });
    return `Search failed: ${error}`;
  }
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

  if (tu.name === "inspect") {
    try {
      const text = await execInspect((tu.input as UrlToolInput) ?? {}, ctx);
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
      const out = await execFetch((tu.input as UrlToolInput) ?? {}, ctx);
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

function validateHttpUrl(url: string, toolName: string): string | null {
  if (!url) return `Error: ${toolName} requires a \`url\`.`;
  if (!/^https?:\/\//i.test(url)) {
    return `Error: not an http(s) URL: ${url}`;
  }
  return null;
}

async function scrapeWithCache(
  ctx: AgentContext,
  url: string,
): Promise<ScrapeCacheEntry> {
  let scrapePromise = ctx.caches.scrape.get(url);
  if (!scrapePromise) {
    scrapePromise = fetchPlainPage({ url, signal: ctx.signal }).then(async (plain) => {
      if (plain.ok) return plain.page;

      ctx.emit({
        type: "steel_fallback",
        url,
        reason: plain.reason,
      });
      const scrape = await runSteelRequest(ctx, () =>
        ctx.steel.scrape(
          {
            url,
            format: ["markdown"],
            useProxy: ctx.useProxy,
          },
          { signal: ctx.signal },
        ),
      );
      return {
        markdown: scrape.content?.markdown ?? "",
        title: scrape.metadata?.title ?? null,
      };
    });
    ctx.caches.scrape.set(url, scrapePromise);
  }

  try {
    return await scrapePromise;
  } catch (err) {
    ctx.caches.scrape.delete(url);
    throw err;
  }
}

async function execInspect(
  args: UrlToolInput,
  ctx: AgentContext,
): Promise<string> {
  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl, "inspect");
  if (validationError) return validationError;

  const url = normalizeFetchUrl(requestedUrl);
  if (ctx.sourceUrls.has(url)) {
    const existing = ctx.sources.find((s) => normalizeFetchUrl(s.url) === url);
    return `Already committed as [${existing?.n ?? "?"}]: ${existing?.title ?? requestedUrl}. Inspect a different result or chase a referenced source.`;
  }

  ctx.emit({ type: "inspecting", url });

  try {
    const { markdown, title } = await scrapeWithCache(ctx, url);
    if (!markdown) {
      ctx.caches.scrape.delete(url);
      ctx.emit({
        type: "source_error",
        url,
        error: "Empty markdown",
      });
      return "Empty page (no content fetched).";
    }

    ctx.abort();

    const snippet = markdown.slice(0, INSPECT_SNIPPET_CHARS).trim();
    return `Inspected: ${title ?? url}\nURL: ${url}\nFirst ${INSPECT_SNIPPET_CHARS} chars:\n${snippet}`;
  } catch (err) {
    const message = errorMessage(err);
    ctx.emit({
      type: "source_error",
      url,
      error: message,
    });
    return `Inspect error: ${message}`;
  }
}

async function execFetch(
  args: UrlToolInput,
  ctx: AgentContext,
): Promise<FetchOutcome> {
  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl, "fetch");
  if (validationError) return { text: validationError };

  const reservation = reserveFetch(ctx, requestedUrl);
  if (typeof reservation === "string") return { text: reservation };
  const url = reservation.url;

  ctx.emit({ type: "fetching", url });

  try {
    const { markdown, title } = await scrapeWithCache(ctx, url);
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
    const message = errorMessage(err);
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
          max_tokens: ctx.gatherMaxTokens ?? 2048,
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
      const message = errorMessage(err);
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

export const __testing = {
  normalizeFetchUrl,
  parseRetryAfterSeconds,
  searchEnginesInFallbackOrder,
};
