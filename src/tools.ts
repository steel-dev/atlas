import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import {
  RESEARCH_MODEL,
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
import { normalizeUrlForSource } from "./url.js";

const STORED_MARKDOWN_CAP = 10_000_000;
const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 50_000;
const SEARCH_SNIPPET_CHARS = 500;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const STEEL_RATE_LIMIT_MAX_ATTEMPTS = 6;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 15;
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
  markdown_chars: number;
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
  openedSourceFiles: Map<string, OpenedSourceFile>;
  emit: (e: AgenticEvent) => void;
  abort: () => void;
  /** Forwarded to every Anthropic / Steel / HTTP call so cancellation
   *  interrupts in-flight requests, not just step boundaries. */
  signal?: AbortSignal;
  defaultEngine: Engine;
  useProxy: boolean;
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

const normalizeFetchUrl = normalizeUrlForSource;

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
  return ctx.openedSourceFiles.get(normalizedUrl);
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

function compactSearchResults(
  results: SearchResult[],
  engine: Engine,
): Array<{
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  engine: Engine;
}> {
  return results.map((result) => ({
    rank: result.position,
    title: result.title,
    url: result.url,
    ...(result.snippet
      ? { snippet: result.snippet.slice(0, SEARCH_SNIPPET_CHARS) }
      : {}),
    engine,
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
  let sawEmptyResults = false;
  const engines = searchEnginesInFallbackOrder(ctx.defaultEngine);

  for (const engine of engines) {
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

    const results = dedupeSearchResults(outcome.results, limit);
    if (results.length === 0) {
      sawEmptyResults = true;
      failures.push(`${engine}: no results`);
      continue;
    }

    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: results.length,
    });
    return JSON.stringify(
      {
        query,
        engine,
        results: compactSearchResults(results, engine),
        warnings: failures.length > 0 ? failures : undefined,
      },
      null,
      2,
    );
  }

  const error = failures.join("; ") || "all engines failed";
  ctx.emit({
    type: "search_results",
    index: searchIndex,
    count: 0,
  });
  if (sawEmptyResults) {
    return JSON.stringify(
      {
        query,
        results: [],
        warnings: failures.length > 0 ? failures : undefined,
      },
      null,
      2,
    );
  }
  ctx.emit({
    type: "search_failed",
    index: searchIndex,
    error,
  });
  return `Search failed: ${error}`;
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

function extractionMetadataFromSteel(
  markdownChars: number,
): ExtractionMetadata {
  return {
    markdown_chars: markdownChars,
    extraction_notes: [
      "Fetched with browser-rendered markdown.",
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
    scrapePromise = runSteelRequest(ctx, () =>
      ctx.steel.scrape(
        {
          url,
          format: ["markdown"],
          useProxy: ctx.useProxy,
        },
        { signal: ctx.signal },
      ),
    ).then((scrape) => {
      const markdown = scrape.content?.markdown ?? "";
      return {
        markdown,
        title: scrape.metadata?.title ?? null,
        metadata: extractionMetadataFromSteel(markdown.length),
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

  ctx.abort();

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

    const resolvedTitle = title ?? url;
    const stored = storeMarkdown(markdown);
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
    ctx.openedSourceFiles.set(normalizedUrl, file);

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
          model: RESEARCH_MODEL,
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
          model: RESEARCH_MODEL,
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
