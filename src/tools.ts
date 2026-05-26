import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { FAST_MODEL, type CitedSource, type WriterEffort } from "./pipeline.js";
import {
  ENGINES,
  webSearch,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";
import { fetchPlainPage } from "./plain-fetch.js";

const STORED_MARKDOWN_CAP = 120_000;
const FETCH_SNIPPET_CHARS = 8000;
const DELEGATE_FETCH_SNIPPET_CHARS = 60_000;
const INSPECT_SNIPPET_CHARS = 6000;
const DEFAULT_READ_SOURCE_CHARS = 12_000;
const MAX_READ_SOURCE_CHARS = 30_000;
const SEARCH_SNIPPET_CHARS = 500;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const DEFAULT_DELEGATE_MAX_TOOL_CALLS = 64;
const DEFAULT_MAX_DELEGATES = 8;
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

export interface DelegateState {
  calls: number;
  maxCalls: number;
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
// The agent terminates by emitting a final message with no tool calls, or by
// hitting a runtime safety limit. The agent can inspect freely before committing
// the strongest pages as cited sources.
//
// Global invariants (URL dedup, source cap) are enforced
// INSIDE the tools, so the agent can't break them no matter what it picks.
// ----------------------------------------------------------------------------

export interface AgentContext {
  anthropic: Anthropic;
  steel: Steel;
  sources: CitedSource[];
  sourceUrls: Set<string>;
  sourceMarkdowns: Map<string, string>;
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
  fetchSnippetChars?: number;
  delegateGate?: SteelGate;
  delegateState?: DelegateState;
  delegateDepth?: number;
  delegateMaxToolCalls?: number;
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
      type: "document_fetched";
      url: string;
      title: string;
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "agent_finished"; sources_added: number };

export interface AgenticRunResult {
  fetched_urls: string[];
  tool_calls: number;
  finish_reason: string;
  messages: Anthropic.MessageParam[];
  markdown: string;
}

interface SearchToolInput {
  query?: string;
  limit?: number;
}
interface UrlToolInput {
  url?: string;
}
interface ReadSourceToolInput {
  url?: string;
  offset?: number;
  max_chars?: number;
}
interface DelegateToolInput {
  task?: string;
}

const BASE_AGENT_TOOLS: Anthropic.Tool[] = [
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
            "How many results to request from each search provider. Default depends on the runtime limits.",
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
      "Fetch a URL into this agent's document cache and return the first chars of the page. Use after inspect, or directly when the URL is clearly a high-value source.",
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
    name: "read_source",
    description:
      "Read a contiguous range from a fetched URL in the document cache. Use this after fetch when you need details, methods, exact evidence, or contradictions; pass offset to continue reading.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL previously fetched in this agent.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Character offset into the stored source text. Default 0.",
        },
        max_chars: {
          type: "integer",
          minimum: 1000,
          maximum: MAX_READ_SOURCE_CHARS,
          description:
            "Maximum characters to return. Default 12000, hard cap 30000.",
        },
      },
      required: ["url"],
    } as Anthropic.Tool["input_schema"],
  },
];

const AGENT_TOOLS: Anthropic.Tool[] = [
  ...BASE_AGENT_TOOLS,
  {
    name: "delegate",
    description:
      "Spawn a focused research subtask when parallel or isolated investigation would materially improve the answer. The child uses its own local sources and returns a concise brief plus URLs worth fetching in the parent.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A focused natural-language research task for the child agent.",
        },
      },
      required: ["task"],
    } as Anthropic.Tool["input_schema"],
  },
];

const AGENT_SYSTEM = `You're a deep research agent. Use search, inspect, fetch, read_source, and delegate to answer the user's question. Work within the user's dollar/time budget. Do not spend most of the run repeatedly searching; after useful search results appear, inspect or fetch the strongest candidates. Use read_source to read deeper into fetched URLs before relying on detailed claims, methods, numbers, or citations. Use delegate when an isolated sub-investigation would materially improve breadth or depth. Delegate briefs are not final citation sources; if a delegated finding matters, fetch the relevant URL in the parent before citing it. Commit enough primary, recent, and independent sources to answer deeply. Prefer chasing citations and original documents over stopping at summaries. When the document cache is strong enough, stop using tools and write the final Markdown report directly. Cite factual claims with Markdown links or source URLs, and end with a '## Sources' section listing the URLs you relied on. Do not cite internal source numbers.`;
const CHILD_AGENT_SYSTEM = `You're a focused research subagent. Use search, inspect, fetch, and read_source to investigate the delegated task. Your fetched documents are local to this subtask and are not parent citations. Read deeply enough to produce a useful brief. When you have enough evidence, stop using tools and write a concise Markdown brief with: key findings, URLs the parent should fetch if this matters, and open uncertainties. Do not write the parent report.`;

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

function markdownHeadingOutline(markdown: string): string {
  const headings = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,4}\s+\S/.test(line))
    .slice(0, 80);

  return headings.length > 0 ? `Heading outline:\n${headings.join("\n")}` : "";
}

function sourcePoolSummary(ctx: AgentContext): string {
  if (ctx.sources.length === 0) return "No sources committed yet.";

  return ctx.sources
    .map((source) => `${source.title} — ${source.url}`)
    .join("\n");
}

function finalReportRequest(ctx: AgentContext): string {
  return (
    `The document cache has ${ctx.sources.length} fetched documents, so you may now finish. ` +
    `Write the final Markdown report directly. Answer the exact question, synthesize rather than merely summarize sources, cite claims with Markdown links or source URLs, and end with a '## Sources' section. Do not cite internal source numbers.`
  );
}

function finalBriefRequest(): string {
  return (
    `Write a concise Markdown brief for the delegated task. Include key findings, URLs the parent should fetch if this matters, and any open uncertainties.`
  );
}

function textFromContent(content: Anthropic.Message["content"]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function delegateState(ctx: AgentContext): DelegateState {
  if (!ctx.delegateState) {
    ctx.delegateState = {
      calls: 0,
      maxCalls: DEFAULT_MAX_DELEGATES,
    };
  }
  return ctx.delegateState;
}

function gatherStartPrompt(opts: {
  query: string;
  maxToolCalls: number;
  sourceCap: number;
  ctx: AgentContext;
  budgetUsd?: number;
  mode: "report" | "brief";
}): string {
  const dollarBudget =
    opts.budgetUsd !== undefined
      ? `User budget hint: up to $${opts.budgetUsd.toFixed(2)} for this run. Use it when more evidence will materially improve the answer.\n`
      : "";
  const sourcePool =
    opts.ctx.sources.length > 0
      ? `Existing document cache:\n${sourcePoolSummary(opts.ctx)}\n\n`
      : "";
  const terminalInstruction =
    opts.mode === "report"
      ? `When the document cache is strong enough, stop emitting tool calls and write the final Markdown report directly.`
      : `When you have investigated the delegated task enough, stop emitting tool calls and write a concise cited Markdown brief for the parent agent.`;
  return (
    `Research question: ${opts.query}\n\n` +
    dollarBudget +
    `Runtime safety limits: at most ${opts.maxToolCalls} tool calls and ${opts.sourceCap} fetched documents.\n\n` +
    sourcePool +
    `Gather enough evidence. Avoid search-only loops: use search to discover candidates, then inspect or fetch the best sources. Use read_source(url, offset) on fetched URLs when you need more than the initial fetch excerpt. ${terminalInstruction}`
  );
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
    return `Already fetched: ${existing?.title ?? url}. Pick a different result or use read_source with the URL.`;
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

async function execReadSource(
  args: ReadSourceToolInput,
  ctx: AgentContext,
): Promise<string> {
  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl, "read_source");
  if (validationError) return validationError;

  const url = normalizeFetchUrl(requestedUrl);
  const source = ctx.sources.find((item) => normalizeFetchUrl(item.url) === url);
  if (!source) {
    return `Error: URL has not been fetched in this agent: ${url}`;
  }

  const markdown = ctx.sourceMarkdowns.get(source.url);
  if (!markdown?.trim()) {
    return `Fetched URL has no stored markdown text: ${url}`;
  }

  const outline = markdownHeadingOutline(markdown);
  const offsetRaw = args.offset ?? 0;
  const maxCharsRaw = args.max_chars ?? DEFAULT_READ_SOURCE_CHARS;
  const offset = Math.floor(Number(offsetRaw));
  const maxChars = Math.min(
    MAX_READ_SOURCE_CHARS,
    Math.max(1000, Math.floor(Number(maxCharsRaw))),
  );
  if (!Number.isFinite(offset) || offset < 0) {
    return `Error: read_source offset must be a non-negative integer.`;
  }
  if (!Number.isFinite(maxChars)) {
    return `Error: read_source max_chars must be a number.`;
  }
  if (offset >= markdown.length) {
    return `Fetched document: ${source.title}\nURL: ${source.url}\n\nOffset ${offset} is past the end of the stored source (${markdown.length} chars).`;
  }

  const end = Math.min(markdown.length, offset + maxChars);
  const sourceText = markdown.slice(offset, end).trim();
  const nextOffset =
    end < markdown.length
      ? `\nNext offset: ${end}`
      : "\nEnd of stored source.";

  return (
    `Fetched document: ${source.title}\nURL: ${source.url}\n\n` +
    (outline ? `${outline}\n\n` : "") +
    `Source text (${offset}-${end} of ${markdown.length} chars):\n${sourceText}${nextOffset}`
  );
}

interface FetchOutcome {
  text: string;
  fetched_url?: string;
}

interface ToolExecution {
  toolResult: Anthropic.ToolResultBlockParam;
  fetched_url?: string;
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

async function execDelegate(
  args: DelegateToolInput,
  ctx: AgentContext,
): Promise<string> {
  const task = String(args.task ?? "").trim();
  if (!task) return "Error: delegate requires a non-empty `task`.";

  const state = delegateState(ctx);
  if (state.calls >= state.maxCalls) {
    return `Delegate limit reached (${state.maxCalls}). Continue in the parent thread.`;
  }
  state.calls++;

  const runChild = async () => {
    const childSources: CitedSource[] = [];
    const childSourceUrls = new Set<string>();
    const childSourceMarkdowns = new Map<string, string>();
    const child = await runGatherAgent({
      ctx: {
        ...ctx,
        sources: childSources,
        sourceUrls: childSourceUrls,
        sourceMarkdowns: childSourceMarkdowns,
        sourceReservations: createSourceReservations(),
        delegateDepth: (ctx.delegateDepth ?? 0) + 1,
        fetchSnippetChars: DELEGATE_FETCH_SNIPPET_CHARS,
      },
      query: task,
      max_tool_calls: ctx.delegateMaxToolCalls ?? DEFAULT_DELEGATE_MAX_TOOL_CALLS,
      mode: "brief",
      allowDelegate: false,
    });
    const brief = child.markdown.trim() || "(Child produced no brief.)";
    const localSources =
      childSources.length > 0
        ? childSources
            .map((source) => `${source.title} — ${source.url}`)
            .join("\n")
        : "No local sources committed.";
    return (
      `Delegate completed: ${task}\n` +
      `Local sources: ${childSources.length}; child tool calls: ${child.tool_calls}; finish reason: ${child.finish_reason}.\n` +
      `These local sources are not parent citations. The parent must fetch any URL it wants to cite.\n\n` +
      `Local source list:\n${localSources}\n\n` +
      brief
    );
  };

  return ctx.delegateGate ? ctx.delegateGate.run(runChild) : runChild();
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
        fetched_url: out.fetched_url,
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

  if (tu.name === "read_source") {
    try {
      const text = await execReadSource(
        (tu.input as ReadSourceToolInput) ?? {},
        ctx,
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

  if (tu.name === "delegate") {
    try {
      const text = await execDelegate((tu.input as DelegateToolInput) ?? {}, ctx);
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
    return `Already fetched: ${existing?.title ?? requestedUrl}. Inspect a different result or use read_source with this URL.`;
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

    // Add while the reservation is still held so cache entries and caps stay
    // consistent across parallel tool calls.
    const resolvedTitle = title ?? url;
    ctx.sources.push({
      url,
      title: resolvedTitle,
    });
    ctx.sourceUrls.add(url);
    ctx.sourceMarkdowns.set(url, markdown.slice(0, STORED_MARKDOWN_CAP));

    ctx.emit({
      type: "document_fetched",
      url,
      title: resolvedTitle,
    });

    const snippetChars = ctx.fetchSnippetChars ?? FETCH_SNIPPET_CHARS;
    const snippet = markdown.slice(0, snippetChars).trim();
    const nextOffset = Math.min(snippetChars, markdown.length);
    return {
      fetched_url: url,
      text: `Fetched: ${resolvedTitle}\nURL: ${url}\nSaved in document cache. Use read_source with this URL and offset ${nextOffset} for deeper reading.\nFirst ${snippetChars.toLocaleString()} chars:\n${snippet}`,
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
  budgetUsd?: number;
  effort?: WriterEffort;
  mode?: "report" | "brief";
  allowDelegate?: boolean;
}): Promise<AgenticRunResult> {
  const { ctx, query } = opts;
  const maxToolCalls = opts.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
  const mode = opts.mode ?? "report";

  ctx.emit({ type: "agent_started" });

  const myFetchedUrls: string[] = [];
  let toolCalls = 0;
  let finishReason = "tool call budget exhausted";
  let markdown = "";
  let searchIndex = 0;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: gatherStartPrompt({
        query,
        maxToolCalls,
        sourceCap: ctx.globalSourceCap,
        ctx,
        budgetUsd: opts.budgetUsd,
        mode,
      }),
    },
  ];

  while (toolCalls < maxToolCalls && ctx.sources.length < ctx.globalSourceCap) {
    ctx.abort();

    let resp: Anthropic.Message;
    const effortConfig = opts.effort
      ? {
          thinking: { type: "adaptive" as const },
          output_config: { effort: opts.effort },
        }
      : {};
    try {
      resp = await ctx.anthropic.messages.create(
        {
          model: ctx.fastModel ?? FAST_MODEL,
          max_tokens: ctx.gatherMaxTokens ?? 2048,
          system: mode === "brief" ? CHILD_AGENT_SYSTEM : AGENT_SYSTEM,
          tools: opts.allowDelegate === false ? BASE_AGENT_TOOLS : AGENT_TOOLS,
          messages,
          cache_control: { type: "ephemeral" },
          ...effortConfig,
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
      const text = textFromContent(resp.content);
      const content =
        mode === "brief" && text
          ? null
          : mode === "brief"
            ? finalBriefRequest()
            : text
              ? null
              : finalReportRequest(ctx);
      if (content === null) {
        markdown = text;
        finishReason = mode === "brief" ? "brief" : "final report";
        break;
      }

      messages.push({ role: "user", content });
      toolCalls += 1;
      if (toolCalls >= maxToolCalls) {
        finishReason = "tool call budget exhausted";
        break;
      }
      continue;
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
      if (execution.fetched_url !== undefined) {
        myFetchedUrls.push(execution.fetched_url);
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
    sources_added: myFetchedUrls.length,
  });

  return {
    fetched_urls: [...myFetchedUrls],
    tool_calls: toolCalls,
    finish_reason: finishReason,
    messages: [...messages],
    markdown,
  };
}

export const __testing = {
  normalizeFetchUrl,
  parseRetryAfterSeconds,
  searchEnginesInFallbackOrder,
};
