import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { FAST_MODEL, type CitedSource, type ResearchEffort } from "./pipeline.js";
import {
  ENGINES,
  webSearch,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";
import { fetchPlainPage, type PlainPageMetadata } from "./plain-fetch.js";

const STORED_MARKDOWN_CAP = 10_000_000;
const FETCH_SNIPPET_CHARS = 8000;
const DEFAULT_READ_FILE_LINES = 240;
const MAX_READ_FILE_LINES = 2000;
const DEFAULT_SEARCH_FILE_RESULTS = 12;
const MAX_SEARCH_FILE_RESULTS = 50;
const SEARCH_FILE_CONTEXT_LINES = 3;
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
  path: string;
  url: string;
  title: string;
  markdown: string;
  lines: string[];
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
  const normalized = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
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
// A single gather loop gets these tools:
//   - search(query, limit?)
//   - open_url(url) — fetch a page into the in-memory working set
//
// The agent terminates by emitting a final message with no tool calls, or by
// hitting a runtime safety limit. The agent can read deeper ranges from opened
// pages when the initial excerpt is not enough.
//
// Runtime invariants (URL dedup, opened-page cap) are enforced
// INSIDE the tools, so the agent can't break them no matter what it picks.
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
interface UrlToolInput {
  url?: string;
}
interface ReadFileToolInput {
  path?: string;
  start_line?: number;
  max_lines?: number;
}
interface SearchFilesToolInput {
  query?: string;
  path?: string;
  max_results?: number;
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
          description: "Maximum results to request.",
        },
      },
      required: ["query"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "open_url",
    description:
      "Open a URL and save its page text as a virtual Markdown file under /sources.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to open.",
        },
      },
      required: ["url"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "list_sources",
    description: "List the virtual Markdown source files opened in this run.",
    input_schema: {
      type: "object",
      properties: {},
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "read_file",
    description: "Read line ranges from a virtual Markdown source file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Virtual source path, for example /sources/001-example.md.",
        },
        start_line: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line. Default 1.",
        },
        max_lines: {
          type: "integer",
          minimum: 1,
          maximum: MAX_READ_FILE_LINES,
          description:
            `Maximum lines to return. Default ${DEFAULT_READ_FILE_LINES}, hard cap ${MAX_READ_FILE_LINES}.`,
        },
      },
      required: ["path"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "search_files",
    description:
      "Search text within opened virtual source files and return line snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Term or phrase to search for in opened source files.",
        },
        path: {
          type: "string",
          description:
            "Optional virtual source path or /sources prefix to narrow the search.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_FILE_RESULTS,
          description:
            `Maximum matches to return. Default ${DEFAULT_SEARCH_FILE_RESULTS}, hard cap ${MAX_SEARCH_FILE_RESULTS}.`,
        },
      },
      required: ["query"],
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
      files,
    );
    files.set(file.path, file);
  });
  ctx.openedSourceFiles = files;
  return files;
}

function unknownExtractionMetadata(markdownChars: number): ExtractionMetadata {
  return {
    fetch_method: "steel",
    markdown_chars: markdownChars,
    extraction_notes: ["Extraction metadata is unavailable for this preloaded source."],
  };
}

function createSourceFile(
  url: string,
  title: string,
  markdown: string,
  metadata: ExtractionMetadata,
  takenPaths: { has(path: string): boolean },
  originalChars = markdown.length,
): OpenedSourceFile {
  const path = sourceFilePath(title, url, takenPaths);
  return {
    path,
    url,
    title,
    markdown,
    lines: markdown.split("\n"),
    original_chars: originalChars,
    stored_chars: markdown.length,
    truncated: originalChars > markdown.length,
    metadata,
  };
}

function sourceFilePath(
  title: string,
  url: string,
  takenPaths: { has(path: string): boolean },
): string {
  const titleSlug = slugifySourceTitle(title);
  const hostSlug = slugifySourceTitle(safeHostname(url));
  const baseSlug = titleSlug || hostSlug || "source";

  const base = `/sources/${baseSlug}.md`;
  if (!takenPaths.has(base)) return base;

  if (titleSlug && hostSlug && hostSlug !== titleSlug) {
    const withHost = `/sources/${titleSlug}-${hostSlug}.md`;
    if (!takenPaths.has(withHost)) return withHost;
  }

  let n = 2;
  while (takenPaths.has(`/sources/${baseSlug}-${n}.md`)) n++;
  return `/sources/${baseSlug}-${n}.md`;
}

function slugifySourceTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sourceHeadingOutline(file: OpenedSourceFile): string {
  const headings = file.lines
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => /^#{1,4}\s+\S/.test(line))
    .slice(0, 80)
    .map(({ line, lineNumber }) => `${lineNumber}: ${line}`);

  return headings.length > 0 ? `Outline:\n${headings.join("\n")}` : "";
}

function findSourceFile(
  ctx: AgentContext,
  path: string,
): OpenedSourceFile | undefined {
  const normalizedPath = path.trim();
  return sourceFiles(ctx).get(normalizedPath);
}

function formatFileLines(
  file: OpenedSourceFile,
  startLine: number,
  maxLines: number,
): string {
  const endLine = Math.min(file.lines.length, startLine + maxLines - 1);
  const width = String(endLine).length;
  const body = file.lines
    .slice(startLine - 1, endLine)
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(width, " ");
      return `${lineNumber}|${line}`;
    })
    .join("\n");
  const next =
    endLine < file.lines.length
      ? `\nNext line: ${endLine + 1}`
      : "\nEnd of file.";

  return (
    `File: ${file.path}\nTitle: ${file.title}\nURL: ${file.url}\n` +
    `${formatSourceEvidenceSummary(file)}\n` +
    `Lines ${startLine}-${endLine} of ${file.lines.length}:\n${body}${next}`
  );
}

function formatSourceEvidenceSummary(file: OpenedSourceFile): string {
  const storage = file.truncated
    ? `Stored markdown: ${file.stored_chars.toLocaleString()} of ${file.original_chars.toLocaleString()} chars (TRUNCATED; later content is unavailable).`
    : `Stored markdown: ${file.stored_chars.toLocaleString()} chars (complete for this extraction).`;
  return [
    `Extraction method: ${file.metadata.fetch_method}`,
    storage,
  ].join("\n");
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

interface OpenReservation {
  url: string;
}

function reserveOpen(ctx: AgentContext, url: string): OpenReservation | string {
  const normalizedUrl = normalizeFetchUrl(url);
  if (ctx.openedPageUrls.has(normalizedUrl)) {
    const existing = ctx.openedPages.find((s) => normalizeFetchUrl(s.url) === normalizedUrl);
    return `Already opened: ${existing?.title ?? url}. Use list_sources/read_file/search_files or pick a different result.`;
  }
  if (ctx.openReservations.urls.has(normalizedUrl)) {
    return `Already being opened: ${url}. Pick a different result.`;
  }

  if (totalOpenSlots(ctx) >= ctx.openedPageCap) {
    return `Opened page cap reached (${ctx.openedPageCap}). Stop opening new pages.`;
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
  const engineCounts: string[] = [];
  const rawResults: Array<SearchResult & { engine: Engine; engine_rank: number }> = [];

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
      engineCounts.push(`${engine}: 0`);
      continue;
    }

    engineCounts.push(`${engine}: ${outcome.results.length}`);
    rawResults.push(
      ...outcome.results.map((result, index) => ({
        ...result,
        engine,
        engine_rank: index + 1,
      })),
    );
  }

  const seen = new Set<string>();
  const results: Array<SearchResult & { engine: Engine; engine_rank: number }> = [];
  for (const result of rawResults) {
    const key = normalizeFetchUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      ...result,
      position: results.length + 1,
    });
    if (results.length >= limit) break;
  }

  if (results.length > 0) {
    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: results.length,
    });

    const lines = results.map((result, index) =>
      formatSearchResult(
        result,
        index,
        `${result.engine} rank ${result.engine_rank}`,
      ),
    );
    return (
      `Search metadata:\n` +
      `Query: ${query}\n` +
      `Engines tried: ${searchEnginesInFallbackOrder(ctx.defaultEngine).join(", ")}\n` +
      `Raw results by engine: ${engineCounts.join(", ")}\n` +
      `Failures: ${failures.length > 0 ? failures.join("; ") : "none"}\n` +
      `Deduplicated results returned: ${results.length} of ${rawResults.length} raw result${rawResults.length === 1 ? "" : "s"}.\n\n` +
      `${results.length} result${results.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`
    );
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

function execListSources(ctx: AgentContext): string {
  const files = [...sourceFiles(ctx).values()];
  if (files.length === 0) {
    return "No source files opened yet. Use open_url to create files under /sources.";
  }

  return (
    `Opened source files (${files.length}):\n\n` +
    files
      .map((file) =>
        `${file.path}\n  Title: ${file.title}\n  URL: ${file.url}\n  Lines: 1-${file.lines.length}\n  Method: ${file.metadata.fetch_method}\n  Markdown: ${file.stored_chars.toLocaleString()}${file.truncated ? ` of ${file.original_chars.toLocaleString()} chars (TRUNCATED)` : " chars"}`,
      )
      .join("\n\n")
  );
}

function execReadFile(args: ReadFileToolInput, ctx: AgentContext): string {
  const path = String(args.path ?? "").trim();
  if (!path) return "Error: read_file requires a `path`.";

  const file = findSourceFile(ctx, path);
  if (!file) {
    return `Error: source file not found: ${path}. Use list_sources to see opened files.`;
  }

  const startLineRaw = args.start_line ?? 1;
  const maxLinesRaw = args.max_lines ?? DEFAULT_READ_FILE_LINES;
  const startLine = Math.floor(Number(startLineRaw));
  const maxLines = Math.min(
    MAX_READ_FILE_LINES,
    Math.max(1, Math.floor(Number(maxLinesRaw))),
  );
  if (!Number.isFinite(startLine) || startLine < 1) {
    return "Error: read_file start_line must be a positive integer.";
  }
  if (!Number.isFinite(maxLines)) {
    return "Error: read_file max_lines must be a number.";
  }
  if (startLine > file.lines.length) {
    return `File: ${file.path}\nTitle: ${file.title}\nURL: ${file.url}\n\nStart line ${startLine} is past the end of the file (${file.lines.length} lines).`;
  }

  return formatFileLines(file, startLine, maxLines);
}

function searchFileMatches(
  file: OpenedSourceFile,
  query: string,
): Array<{ lineNumber: number; line: string }> {
  const needle = query.toLowerCase();
  const terms = needle.split(/\s+/).filter((term) => term.length > 1);

  return file.lines.flatMap((line, index) => {
    const haystack = line.toLowerCase();
    const matched =
      haystack.includes(needle) ||
      (terms.length > 1 && terms.every((term) => haystack.includes(term)));
    return matched ? [{ lineNumber: index + 1, line }] : [];
  });
}

function sourceFilesForSearch(
  ctx: AgentContext,
  path: string | undefined,
): OpenedSourceFile[] {
  const files = [...sourceFiles(ctx).values()];
  const normalizedPath = path?.trim();
  if (!normalizedPath || normalizedPath === "/sources" || normalizedPath === "/sources/") {
    return files;
  }
  return files.filter((file) => file.path === normalizedPath);
}

function formatSearchFileSnippet(
  file: OpenedSourceFile,
  lineNumber: number,
): string {
  const startLine = Math.max(1, lineNumber - SEARCH_FILE_CONTEXT_LINES);
  const endLine = Math.min(file.lines.length, lineNumber + SEARCH_FILE_CONTEXT_LINES);
  const width = String(endLine).length;
  const body = file.lines
    .slice(startLine - 1, endLine)
    .map((line, index) => {
      const currentLine = startLine + index;
      const marker = currentLine === lineNumber ? ">" : " ";
      return `${marker}${String(currentLine).padStart(width, " ")}|${line}`;
    })
    .join("\n");

  return `${file.path}:${lineNumber}\nTitle: ${file.title}\nURL: ${file.url}\n${formatSourceEvidenceSummary(file)}\n${body}`;
}

function execSearchFiles(args: SearchFilesToolInput, ctx: AgentContext): string {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: search_files requires a non-empty `query`.";

  const maxResultsRaw = args.max_results ?? DEFAULT_SEARCH_FILE_RESULTS;
  const maxResults = Math.min(
    MAX_SEARCH_FILE_RESULTS,
    Math.max(1, Math.floor(Number(maxResultsRaw))),
  );
  if (!Number.isFinite(maxResults)) {
    return "Error: search_files max_results must be a number.";
  }

  const files = sourceFilesForSearch(ctx, args.path);
  if (files.length === 0) {
    return args.path
      ? `No opened source files match path: ${args.path}`
      : "No source files opened yet. Use open_url before search_files.";
  }

  const snippets: string[] = [];
  for (const file of files) {
    for (const match of searchFileMatches(file, query)) {
      snippets.push(formatSearchFileSnippet(file, match.lineNumber));
      if (snippets.length >= maxResults) break;
    }
    if (snippets.length >= maxResults) break;
  }

  if (snippets.length === 0) {
    return `No matches for "${query}" in ${files.length} opened source file${files.length === 1 ? "" : "s"}.`;
  }

  return `${snippets.length} match${snippets.length === 1 ? "" : "es"} for "${query}":\n\n${snippets.join("\n\n")}`;
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

  if (tu.name === "open_url") {
    try {
      const out = await execFetch((tu.input as UrlToolInput) ?? {}, ctx);
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

  if (tu.name === "list_sources") {
    try {
      const text = execListSources(ctx);
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

  if (tu.name === "read_file") {
    try {
      const text = execReadFile((tu.input as ReadFileToolInput) ?? {}, ctx);
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

  if (tu.name === "search_files") {
    try {
      const text = execSearchFiles((tu.input as SearchFilesToolInput) ?? {}, ctx);
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

function extractionMetadataFromPlain(metadata: PlainPageMetadata): ExtractionMetadata {
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

function formatExtractionMetadata(metadata: ExtractionMetadata): string {
  const lines = [
    "Extraction metadata:",
    `- Method: ${metadata.fetch_method}`,
    `- Markdown chars from extractor: ${metadata.markdown_chars.toLocaleString()}`,
  ];
  if (metadata.content_type) {
    lines.push(`- Content-Type: ${metadata.content_type}`);
  }
  if (metadata.raw_chars !== undefined) {
    lines.push(`- Raw response chars: ${metadata.raw_chars.toLocaleString()}`);
  }
  if (metadata.raw_truncated) {
    lines.push("- Raw response was truncated before extraction.");
  }
  if (metadata.plain_failure_reason) {
    lines.push(`- Plain fetch fallback reason: ${metadata.plain_failure_reason}`);
  }
  for (const note of metadata.extraction_notes) {
    lines.push(`- Note: ${note}`);
  }
  return lines.join("\n");
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
    scrapePromise = fetchPlainPage({ url, signal: ctx.signal }).then(async (plain) => {
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

async function execFetch(
  args: UrlToolInput,
  ctx: AgentContext,
): Promise<OpenOutcome> {
  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl, "open_url");
  if (validationError) return { text: validationError };

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
      return { text: `Empty page (no content opened).` };
    }

    ctx.abort();

    // Add while the reservation is still held so cache entries and caps stay
    // consistent across parallel tool calls.
    const resolvedTitle = title ?? url;
    const stored = storeMarkdown(markdown);
    const file = createSourceFile(
      url,
      resolvedTitle,
      stored.markdown,
      metadata,
      sourceFiles(ctx),
      stored.originalChars,
    );
    ctx.openedPages.push({
      url,
      title: resolvedTitle,
    });
    ctx.openedPageUrls.add(url);
    ctx.openedPageMarkdowns.set(url, stored.markdown);
    sourceFiles(ctx).set(file.path, file);

    ctx.emit({
      type: "page_opened",
      url,
      title: resolvedTitle,
    });

    const snippetChars = ctx.fetchSnippetChars ?? FETCH_SNIPPET_CHARS;
    const previewLines = Math.max(
      1,
      stored.markdown.slice(0, snippetChars).split("\n").length,
    );
    const preview = formatFileLines(file, 1, Math.min(DEFAULT_READ_FILE_LINES, previewLines));
    const outline = sourceHeadingOutline(file);
    const storageLine = file.truncated
      ? `Storage: stored ${file.stored_chars.toLocaleString()} of ${file.original_chars.toLocaleString()} markdown chars (TRUNCATED; unavailable tail may contain evidence).\n`
      : `Storage: stored complete extracted markdown (${file.stored_chars.toLocaleString()} chars).\n`;
    return {
      opened_url: url,
      text:
        `Opened source file: ${file.path}\nTitle: ${resolvedTitle}\nURL: ${url}\n` +
        `Lines: 1-${file.lines.length}\n` +
        storageLine +
        `${formatExtractionMetadata(metadata)}\n` +
        (outline ? `${outline}\n\n` : "\n") +
        `${preview}\n\nUse read_file with ${file.path} and a start_line for deeper reading, or search_files to search opened sources.`,
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
      (tu, index) =>
        executeToolUse(
          tu,
          ctx,
          searchIndexes[index],
        ),
    );
    const toolResults = [
      ...executions.map((e) => e.toolResult),
      ...skippedToolUses.map((tu): Anthropic.ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: tu.id,
        content: "Tool not run: tool call budget exhausted.",
        is_error: true,
      })),
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

  if (
    !markdown &&
    (finishReason === "tool call budget exhausted" ||
      finishReason === "opened page cap reached")
  ) {
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
