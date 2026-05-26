import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import {
  FAST_MODEL,
  type CitedSource,
  type ResearchEffort,
} from "./pipeline.js";
import {
  ENGINES,
  webSearch,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";
import { fetchPlainPage, type PlainPageMetadata } from "./plain-fetch.js";

const STORED_MARKDOWN_CAP = 10_000_000;
const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 50_000;
const SEARCH_SNIPPET_CHARS = 500;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const STEEL_RATE_LIMIT_MAX_ATTEMPTS = 6;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 15;
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

export interface OpenReservations {
  urls: Set<string>;
  pageSlots: number;
}

interface ScrapeCacheEntry {
  markdown: string;
  title: string | null;
  metadata: ExtractionMetadata;
}

interface ExtractionMetadata {
  fetch_method: "plain" | "steel";
  content_type?: string;
  raw_chars?: number;
  raw_truncated?: boolean;
  markdown_chars: number;
  plain_failure_reason?: string;
  extraction_notes: string[];
}

export interface OpenedSourceFile {
  url: string;
  title: string;
  markdown: string;
  original_chars: number;
  stored_chars: number;
  truncated: boolean;
  metadata: ExtractionMetadata;
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

export function createOpenReservations(): OpenReservations {
  return {
    urls: new Set<string>(),
    pageSlots: 0,
  };
}

// ----------------------------------------------------------------------------
// Agentic gather loop
//
// The harness exposes only web search and page fetch. Re-fetching the same URL
// with offset/max_chars reads more of cached content without a virtual file layer.
// ----------------------------------------------------------------------------

export interface AgentContext {
  anthropic: Anthropic;
  steel: Steel;
  openedPages: CitedSource[];
  openedPageUrls: Set<string>;
  openedPageMarkdowns: Map<string, string>;
  openedSourceFiles?: Map<string, OpenedSourceFile>;
  emit: (e: AgenticEvent) => void;
  abort: () => void;
  /** Forwarded to every Anthropic / Steel / HTTP call so cancellation
   *  interrupts in-flight requests, not just step boundaries. */
  signal?: AbortSignal;
  defaultEngine: Engine;
  useProxy: boolean;
  fastModel?: string;
  openedPageCap: number;
  gatherMaxTokens?: number;
  defaultSearchLimit?: number;
  maxConcurrentTools?: number;
  fetchSnippetChars?: number;
  steelGate: SteelGate;
  openReservations: OpenReservations;
  caches: ResearchCaches;
}

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
  | { type: "steel_fallback"; url: string; reason: string }
  | {
      type: "rate_limited";
      retry_after_seconds: number;
      attempt: number;
      max_attempts: number;
    }
  | {
      type: "page_opened";
      url: string;
      title: string;
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "agent_finished"; pages_opened: number };

export interface AgenticRunResult {
  opened_urls: string[];
  tool_calls: number;
  finish_reason: string;
  messages: Anthropic.MessageParam[];
  markdown: string;
}

interface SearchToolInput {
  query?: string;
  limit?: number;
}

interface FetchToolInput {
  url?: string;
  offset?: number;
  max_chars?: number;
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search",
    description: "Search the web.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum results to return.",
        },
      },
      required: ["query"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "fetch",
    description:
      "Fetch a URL as Markdown. Use offset/max_chars to continue reading long pages.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to start reading from. Default 0.",
        },
        max_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_CHARS,
          description: `Maximum characters to return. Default ${DEFAULT_FETCH_CHARS}, hard cap ${MAX_FETCH_CHARS}.`,
        },
      },
    } as Anthropic.Tool["input_schema"],
  },
];

const AGENT_SYSTEM = `You're a deep research agent. Use the available tools as needed to answer the user's question. When you have enough evidence, stop using tools and write a cited Markdown report.`;

function totalOpenSlots(ctx: AgentContext): number {
  return ctx.openedPages.length + ctx.openReservations.pageSlots;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourceFiles(ctx: AgentContext): Map<string, OpenedSourceFile> {
  if (ctx.openedSourceFiles) return ctx.openedSourceFiles;

  const files = new Map<string, OpenedSourceFile>();
  ctx.openedPages.forEach((page) => {
    const markdown = ctx.openedPageMarkdowns.get(page.url);
    if (!markdown) return;
    const file = createSourceFile(
      page.url,
      page.title,
      markdown,
      unknownExtractionMetadata(markdown.length),
    );
    files.set(normalizeFetchUrl(file.url), file);
  });
  ctx.openedSourceFiles = files;
  return files;
}

function unknownExtractionMetadata(markdownChars: number): ExtractionMetadata {
  return {
    fetch_method: "steel",
    markdown_chars: markdownChars,
    extraction_notes: [
      "Extraction metadata is unavailable for this preloaded source.",
    ],
  };
}

function createSourceFile(
  url: string,
  title: string,
  markdown: string,
  metadata: ExtractionMetadata,
  originalChars = markdown.length,
): OpenedSourceFile {
  return {
    url,
    title,
    markdown,
    original_chars: originalChars,
    stored_chars: markdown.length,
    truncated: originalChars > markdown.length,
    metadata,
  };
}

function findSourceByUrl(
  ctx: AgentContext,
  normalizedUrl: string,
): OpenedSourceFile | undefined {
  return sourceFiles(ctx).get(normalizedUrl);
}

function textFromContent(content: Anthropic.Message["content"]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function gatherStartPrompt(opts: { query: string }): string {
  return `Research question: ${opts.query}`;
}

function finalSynthesisPrompt(reason: string): string {
  return (
    `Runtime limit reached: ${reason}.\n\n` +
    "Do not call any more tools. Using only the evidence already gathered in this conversation, write the best possible cited Markdown report. If the evidence is incomplete, state the uncertainty and gaps clearly."
  );
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => string | null }).get(
      name,
    );
    return value ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function parseRetryAfterSeconds(err: unknown): number | null {
  const status = (err as { status?: number })?.status;
  const message = errorMessage(err);
  if (
    status !== 429 &&
    !/(rate limit exceeded|too many requests)/i.test(message)
  ) {
    return null;
  }

  const headerValue = readHeader(
    (err as { headers?: unknown })?.headers,
    "retry-after",
  );
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

  const messageMatch = /try again in\s+(\d+(?:\.\d+)?)\s*seconds?/i.exec(
    message,
  );
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

interface OpenReservation {
  url: string;
}

function reserveOpen(ctx: AgentContext, url: string): OpenReservation | string {
  const normalizedUrl = normalizeFetchUrl(url);
  if (ctx.openReservations.urls.has(normalizedUrl)) {
    return `Already being fetched: ${url}. Try another source or continue after this fetch completes.`;
  }
  if (totalOpenSlots(ctx) >= ctx.openedPageCap) {
    return `Opened page cap reached (${ctx.openedPageCap}). Continue reading fetched URLs with offset/max_chars or write the report.`;
  }

  ctx.openReservations.urls.add(normalizedUrl);
  ctx.openReservations.pageSlots++;
  return { url: normalizedUrl };
}

function releaseOpenReservation(
  ctx: AgentContext,
  reservation: OpenReservation,
): void {
  ctx.openReservations.urls.delete(reservation.url);
  ctx.openReservations.pageSlots = Math.max(
    0,
    ctx.openReservations.pageSlots - 1,
  );
}

interface MergedSearchResult extends SearchResult {
  engines: Engine[];
  best_position: number;
  score: number;
  first_engine_index: number;
}

function compactSearchResults(results: MergedSearchResult[]): Array<{
  title: string;
  url: string;
  snippet?: string;
  engines: Engine[];
  best_position: number;
}> {
  return results.map((result) => ({
    title: result.title,
    url: result.url,
    ...(result.snippet
      ? { snippet: result.snippet.slice(0, SEARCH_SNIPPET_CHARS) }
      : {}),
    engines: result.engines,
    best_position: result.best_position,
  }));
}

function dedupeSearchResults(
  results: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeFetchUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...result,
      position: deduped.length + 1,
    });
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function mergeSearchResults(
  batches: Array<{ engine: Engine; results: SearchResult[] }>,
  limit: number,
): MergedSearchResult[] {
  const byUrl = new Map<string, MergedSearchResult>();
  batches.forEach((batch, engineIndex) => {
    const deduped = dedupeSearchResults(batch.results, limit);
    for (const result of deduped) {
      const key = normalizeFetchUrl(result.url);
      const position = Math.max(1, result.position);
      const score = 1 / position;
      const existing = byUrl.get(key);

      if (!existing) {
        byUrl.set(key, {
          ...result,
          engines: [batch.engine],
          best_position: position,
          score,
          first_engine_index: engineIndex,
        });
        continue;
      }

      if (!existing.engines.includes(batch.engine)) {
        existing.engines.push(batch.engine);
      }
      existing.score += score;
      existing.best_position = Math.min(existing.best_position, position);

      if (position < existing.position) {
        existing.position = result.position;
        existing.title = result.title;
        existing.snippet = result.snippet;
        existing.domain = result.domain;
      }
    }
  });

  return [...byUrl.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.best_position - b.best_position ||
        a.first_engine_index - b.first_engine_index ||
        a.url.localeCompare(b.url),
    )
    .slice(0, limit)
    .map((result, index) => ({
      ...result,
      position: index + 1,
    }));
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

  const engines = searchEnginesInFallbackOrder(ctx.defaultEngine);
  const outcomes = await Promise.all(
    engines.map(async (engine) => {
      try {
        const outcome = await searchWithCache(ctx, { query, limit, engine });
        return { engine, outcome };
      } catch (err) {
        return { engine, error: errorMessage(err) };
      }
    }),
  );

  const successes: Array<{ engine: Engine; results: SearchResult[] }> = [];
  const failures: string[] = [];
  const emptyEngines: Engine[] = [];

  for (const result of outcomes) {
    if ("error" in result) {
      failures.push(`${result.engine}: ${result.error}`);
      continue;
    }

    const { engine, outcome } = result;
    if (!outcome.ok) {
      failures.push(`${engine}: ${outcome.error.message}`);
      continue;
    }
    if (outcome.results.length === 0) {
      emptyEngines.push(engine);
      continue;
    }
    successes.push({ engine, results: outcome.results });
  }

  if (successes.length > 0) {
    const results = mergeSearchResults(successes, limit);
    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: results.length,
    });
    return JSON.stringify(
      {
        query,
        engines,
        results: compactSearchResults(results),
        ...(failures.length > 0 ? { warnings: failures } : {}),
      },
      null,
      2,
    );
  }

  if (emptyEngines.length > 0) {
    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: 0,
    });
    return JSON.stringify(
      {
        query,
        engines,
        results: [],
        note: "No results. Try a different query.",
        ...(failures.length > 0 ? { warnings: failures } : {}),
      },
      null,
      2,
    );
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

interface OpenOutcome {
  text: string;
  opened_url?: string;
}

interface ToolExecution {
  toolResult: Anthropic.ToolResultBlockParam;
  opened_url?: string;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
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
        opened_url: out.opened_url,
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

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: tu.id,
      content: `Unknown tool: ${tu.name}. Available tools: search, fetch.`,
      is_error: true,
    },
  };
}

function validateHttpUrl(url: string): string | null {
  if (!url) return "Error: fetch requires `url`.";
  if (!/^https?:\/\//i.test(url)) {
    return `Error: not an http(s) URL: ${url}`;
  }
  return null;
}

function extractionMetadataFromPlain(
  metadata: PlainPageMetadata,
): ExtractionMetadata {
  return {
    fetch_method: "plain",
    content_type: metadata.content_type,
    raw_chars: metadata.raw_chars,
    raw_truncated: metadata.raw_truncated,
    markdown_chars: metadata.markdown_chars,
    extraction_notes: metadata.extraction_notes,
  };
}

function extractionMetadataFromSteel(
  markdownChars: number,
  plainFailureReason: string,
): ExtractionMetadata {
  return {
    fetch_method: "steel",
    markdown_chars: markdownChars,
    plain_failure_reason: plainFailureReason,
    extraction_notes: [
      "Fetched with Steel browser-rendered markdown after plain fetch was insufficient.",
    ],
  };
}

function storeMarkdown(markdown: string): {
  markdown: string;
  originalChars: number;
  truncated: boolean;
} {
  if (markdown.length <= STORED_MARKDOWN_CAP) {
    return {
      markdown,
      originalChars: markdown.length,
      truncated: false,
    };
  }
  return {
    markdown: markdown.slice(0, STORED_MARKDOWN_CAP),
    originalChars: markdown.length,
    truncated: true,
  };
}

async function scrapeWithCache(
  ctx: AgentContext,
  url: string,
): Promise<ScrapeCacheEntry> {
  let scrapePromise = ctx.caches.scrape.get(url);
  if (!scrapePromise) {
    scrapePromise = fetchPlainPage({ url, signal: ctx.signal }).then(
      async (plain) => {
        if (plain.ok) {
          return {
            markdown: plain.page.markdown,
            title: plain.page.title,
            metadata: extractionMetadataFromPlain(plain.page.metadata),
          };
        }

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
        const markdown = scrape.content?.markdown ?? "";
        return {
          markdown,
          title: scrape.metadata?.title ?? null,
          metadata: extractionMetadataFromSteel(markdown.length, plain.reason),
        };
      },
    );
    ctx.caches.scrape.set(url, scrapePromise);
  }

  try {
    return await scrapePromise;
  } catch (err) {
    ctx.caches.scrape.delete(url);
    throw err;
  }
}

function readOffset(args: FetchToolInput): number | string {
  const raw = args.offset ?? 0;
  const offset = Math.floor(Number(raw));
  if (!Number.isFinite(offset) || offset < 0) {
    return "Error: fetch offset must be a non-negative integer.";
  }
  return offset;
}

function readMaxChars(
  args: FetchToolInput,
  ctx: AgentContext,
): number | string {
  const raw = args.max_chars ?? ctx.fetchSnippetChars ?? DEFAULT_FETCH_CHARS;
  const maxChars = Math.min(
    MAX_FETCH_CHARS,
    Math.max(1, Math.floor(Number(raw))),
  );
  if (!Number.isFinite(maxChars)) {
    return "Error: fetch max_chars must be a number.";
  }
  return maxChars;
}

function formatFetchResult(
  file: OpenedSourceFile,
  offset: number,
  maxChars: number,
): string {
  const start = Math.min(offset, file.markdown.length);
  const end = Math.min(file.markdown.length, start + maxChars);
  const content = file.markdown.slice(start, end);
  const hasMore = end < file.markdown.length;
  const result = {
    title: file.title,
    url: file.url,
    offset: start,
    next_offset: hasMore ? end : null,
    has_more: hasMore,
    chars_returned: content.length,
    total_chars_available: file.stored_chars,
    truncated: file.truncated,
    extraction_method: file.metadata.fetch_method,
    content,
  };
  return JSON.stringify(result, null, 2);
}

async function execFetch(
  args: FetchToolInput,
  ctx: AgentContext,
): Promise<OpenOutcome> {
  const offset = readOffset(args);
  if (typeof offset === "string") return { text: offset };
  const maxChars = readMaxChars(args, ctx);
  if (typeof maxChars === "string") return { text: maxChars };

  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl);
  if (validationError) return { text: validationError };
  const normalizedUrl = normalizeFetchUrl(requestedUrl);
  const existing = findSourceByUrl(ctx, normalizedUrl);
  if (existing) {
    return { text: formatFetchResult(existing, offset, maxChars) };
  }

  const reservation = reserveOpen(ctx, requestedUrl);
  if (typeof reservation === "string") return { text: reservation };
  const url = reservation.url;

  ctx.emit({ type: "fetching", url });

  try {
    const { markdown, title, metadata } = await scrapeWithCache(ctx, url);
    if (!markdown) {
      ctx.caches.scrape.delete(url);
      ctx.emit({
        type: "source_error",
        url,
        error: "Empty markdown",
      });
      return { text: "Empty page (no content fetched)." };
    }

    ctx.abort();

    const resolvedTitle = title ?? url;
    const stored = storeMarkdown(markdown);
    const files = sourceFiles(ctx);
    const file = createSourceFile(
      url,
      resolvedTitle,
      stored.markdown,
      metadata,
      stored.originalChars,
    );
    ctx.openedPages.push({
      url,
      title: resolvedTitle,
    });
    ctx.openedPageUrls.add(url);
    ctx.openedPageMarkdowns.set(url, stored.markdown);
    files.set(normalizedUrl, file);

    ctx.emit({
      type: "page_opened",
      url,
      title: resolvedTitle,
    });

    return {
      opened_url: url,
      text: formatFetchResult(file, offset, maxChars),
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
    releaseOpenReservation(ctx, reservation);
  }
}

export async function runGatherAgent(opts: {
  ctx: AgentContext;
  query: string;
  max_tool_calls?: number;
  effort?: ResearchEffort;
}): Promise<AgenticRunResult> {
  const { ctx, query } = opts;
  const maxToolCalls = opts.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;

  ctx.emit({ type: "agent_started" });

  const openedUrls: string[] = [];
  let toolCalls = 0;
  let finishReason = "tool call budget exhausted";
  let markdown = "";
  let searchIndex = 0;
  const effortConfig = opts.effort
    ? {
        thinking: { type: "adaptive" as const },
        output_config: { effort: opts.effort },
      }
    : {};

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: gatherStartPrompt({ query }),
    },
  ];

  while (toolCalls < maxToolCalls) {
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
          ...effortConfig,
        },
        { signal: ctx.signal },
      );
    } catch (err) {
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
      markdown = text;
      finishReason = text ? "final report" : "empty final response";
      break;
    }

    const remainingToolCalls = maxToolCalls - toolCalls;
    const activeToolUses = toolUses.slice(0, remainingToolCalls);
    const skippedToolUses = toolUses.slice(remainingToolCalls);
    const searchIndexes = activeToolUses.map((tu) =>
      tu.name === "search" ? ++searchIndex : undefined,
    );
    toolCalls += activeToolUses.length;

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) => executeToolUse(tu, ctx, searchIndexes[index]),
    );
    const toolResults = [
      ...executions.map((e) => e.toolResult),
      ...skippedToolUses.map(
        (tu): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Tool not run: tool call budget exhausted.",
          is_error: true,
        }),
      ),
    ];
    for (const execution of executions) {
      if (execution.opened_url !== undefined) {
        openedUrls.push(execution.opened_url);
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  if (!markdown && finishReason === "tool call budget exhausted") {
    ctx.abort();
    messages.push({
      role: "user",
      content: finalSynthesisPrompt(finishReason),
    });

    try {
      const resp = await ctx.anthropic.messages.create(
        {
          model: ctx.fastModel ?? FAST_MODEL,
          max_tokens: ctx.gatherMaxTokens ?? 2048,
          system: AGENT_SYSTEM,
          messages,
          cache_control: { type: "ephemeral" },
          ...effortConfig,
        },
        { signal: ctx.signal },
      );
      messages.push({ role: "assistant", content: resp.content });
      const text = textFromContent(resp.content);
      markdown = text;
      finishReason = text
        ? `final report after ${finishReason}`
        : `empty final synthesis after ${finishReason}`;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const message = errorMessage(err);
      finishReason = `final synthesis api error after ${finishReason}: ${message}`;
    }
  }

  ctx.emit({
    type: "agent_finished",
    pages_opened: openedUrls.length,
  });

  return {
    opened_urls: [...openedUrls],
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
