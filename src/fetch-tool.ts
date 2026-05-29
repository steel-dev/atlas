import type { ResearchLoopContext, SourceCacheEntry } from "./runtime.js";
import type { ModelAssistantBlock } from "./model.js";
import type {
  SourceDocument,
  SourceExtractionAttempt,
} from "./sources.js";
import {
  createSourceDocument,
  extractionMetadataFromHtml,
  extractionMetadataFromPdf,
  findSourceDocumentByUrl,
  formatFetchResult,
  formatSourceSummary,
  storeMarkdown,
} from "./source-documents.js";
import { extractSourceWithBrowser } from "./browser-extract.js";
import { errorMessage } from "./errors.js";
import { extractPdfText } from "./pdf-extract.js";
import { looksBlocked } from "./steel.js";
import {
  DEFAULT_FETCH_CHARS,
  FETCH_SUMMARY_SYSTEM_PROMPT,
  MAX_FETCH_CHARS,
  fetchSummaryPrompt,
} from "./tool-contract.js";
import { htmlToMarkdown } from "./html-extract.js";
import { normalizeUrlForSource } from "./url.js";

export interface FetchToolInput {
  url?: string;
  offset?: number;
  max_chars?: number;
}

export interface FetchOutcome {
  text: string;
  fetchedUrl?: string;
}

interface DirectExtractionOutcome {
  entry: SourceCacheEntry | null;
  attempt: SourceExtractionAttempt;
}

interface SourceReservation {
  url: string;
  sourceId: string;
}

export const normalizeFetchUrl = normalizeUrlForSource;

const DIRECT_PDF_MAX_BYTES = 25 * 1024 * 1024;
const DIRECT_HTML_MAX_BYTES = 5 * 1024 * 1024;
const DIRECT_HTML_MIN_CHARS = 100;
const MIN_SOURCE_MARKDOWN_CHARS = 20;
const THIN_SOURCE_MARKDOWN_CHARS = 300;
const PDF_MAGIC = "%PDF";
const DIRECT_FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; AtlasResearchBot/0.1; +https://github.com/steel-experiments/atlas)";
const ERROR_TITLE_PATTERN =
  /\b(?:404|not found|access denied|forbidden|error report|captcha|just a moment|sorry)\b/i;
const SEARCH_LISTING_TITLE_PATTERN =
  /\b(?:search results?|advanced search|site search)\b|검색/i;
const SUMMARY_INPUT_CHARS = 24_000;
const SUMMARY_MAX_TOKENS = 512;
const SUMMARY_MIN_SOURCE_CHARS = 1_200;

function totalSourceSlots(ctx: ResearchLoopContext): number {
  return ctx.fetchedSources.length + ctx.sourceReservations.sourceSlots;
}

function reserveSource(
  ctx: ResearchLoopContext,
  url: string,
): SourceReservation | string {
  const normalizedUrl = normalizeFetchUrl(url);
  if (ctx.sourceReservations.urls.has(normalizedUrl)) {
    return `Already being fetched: ${url}. Try another source or continue after this fetch completes.`;
  }
  if (totalSourceSlots(ctx) >= ctx.sourceCap) {
    return `Fetched source cap reached (${ctx.sourceCap}). Continue reading fetched URLs with offset/max_chars or write the report.`;
  }

  ctx.sourceReservations.urls.add(normalizedUrl);
  ctx.sourceReservations.sourceSlots++;
  return {
    url: normalizedUrl,
    sourceId: `source_${ctx.sourceReservations.nextSourceNumber++}`,
  };
}

function releaseSourceReservation(
  ctx: ResearchLoopContext,
  reservation: SourceReservation,
): void {
  ctx.sourceReservations.urls.delete(reservation.url);
  ctx.sourceReservations.sourceSlots = Math.max(
    0,
    ctx.sourceReservations.sourceSlots - 1,
  );
}

function validateHttpUrl(url: string): string | null {
  if (!url) return "Error: fetch requires `url`.";
  if (!/^https?:\/\//i.test(url)) {
    return `Error: not an http(s) URL: ${url}`;
  }
  return null;
}

async function sourceWithCache(
  ctx: ResearchLoopContext,
  url: string,
): Promise<SourceCacheEntry> {
  let sourcePromise = ctx.caches.sources.get(url);
  if (!sourcePromise) {
    sourcePromise = extractSourceWithFallbacks(ctx, url);
    ctx.caches.sources.set(url, sourcePromise);
  }

  try {
    return await sourcePromise;
  } catch (err) {
    ctx.caches.sources.delete(url);
    throw err;
  }
}

async function extractSourceWithFallbacks(
  ctx: ResearchLoopContext,
  url: string,
): Promise<SourceCacheEntry> {
  const attempts: SourceExtractionAttempt[] = [];
  const direct = await tryDirectExtraction(ctx, url);
  attempts.push(direct.attempt);
  if (direct.entry) return direct.entry;

  return extractSourceWithBrowser(ctx, url, attempts);
}

async function tryDirectExtraction(
  ctx: ResearchLoopContext,
  url: string,
): Promise<DirectExtractionOutcome> {
  try {
    const response = await fetch(url, {
      signal: ctx.signal,
      headers: {
        accept: "application/pdf,*/*;q=0.8",
        "user-agent": DIRECT_FETCH_USER_AGENT,
      },
    });
    if (!response.ok) {
      return failedDirectAttempt(
        "direct_http",
        `http_error: direct fetch returned HTTP ${response.status}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const contentLength = readContentLength(response.headers);
    const maxBytes = isLikelyPdfUrl(url) || isPdfContentType(contentType)
      ? DIRECT_PDF_MAX_BYTES
      : DIRECT_HTML_MAX_BYTES;
    if (contentLength !== undefined && contentLength > maxBytes) {
      return failedDirectAttempt(
        "direct_http",
        `too_large: direct response is too large (${contentLength} bytes)`,
      );
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) {
      return failedDirectAttempt(
        "direct_http",
        `too_large: direct response is too large (${data.byteLength} bytes)`,
      );
    }

    const finalUrl = response.url || url;
    if (isPdfBytes(data) || isPdfContentType(contentType)) {
      return extractDirectPdf(data, { contentType, finalUrl });
    }

    if (!isHtmlContentType(contentType)) {
      return failedDirectAttempt(
        "direct_http",
        contentType
          ? `unsupported_content_type: direct response was ${contentType}`
          : "unsupported_content_type: direct response was not HTML or PDF",
      );
    }

    return extractDirectHtml(data, { contentType, finalUrl });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return failedDirectAttempt(
      "direct_http",
      `network_error: direct fetch failed: ${errorMessage(err)}`,
    );
  }
}

async function extractDirectPdf(
  data: Uint8Array,
  opts: { contentType?: string; finalUrl: string },
): Promise<DirectExtractionOutcome> {
  try {
    const extracted = await extractPdfText(data);
    const markdown = extracted.text.trim();
    if (!markdown) {
      return failedDirectAttempt("pdf_direct", "pdf_no_text: PDF extraction produced no text");
    }
    const attempt = {
      method: "pdf_direct",
      ok: true,
      note: `pdf_direct: extracted ${markdown.length} text chars`,
    };
    return {
      entry: {
        markdown,
        title: titleFromPdfUrl(opts.finalUrl),
        metadata: extractionMetadataFromPdf({
          markdownChars: markdown.length,
          contentType: opts.contentType,
          finalUrl: opts.finalUrl,
          attempts: [attempt],
        }),
      },
      attempt,
    };
  } catch (err) {
    return failedDirectAttempt(
      "pdf_direct",
      `pdf_parse_error: PDF extraction failed: ${errorMessage(err)}`,
    );
  }
}

function extractDirectHtml(
  data: Uint8Array,
  opts: { contentType?: string; finalUrl: string },
): DirectExtractionOutcome {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (looksBlocked(html)) {
    return failedDirectAttempt("html_direct", "blocked_or_challenge: direct HTML looked blocked");
  }

  const extracted = htmlToMarkdown(html, opts.finalUrl);
  if (extracted.markdown.length < DIRECT_HTML_MIN_CHARS) {
    return failedDirectAttempt(
      "html_direct",
      `thin_content: direct HTML extracted ${extracted.markdown.length} chars`,
    );
  }

  const attempt = {
    method: "html_direct",
    ok: true,
    note: `html_direct: extracted ${extracted.markdown.length} text chars`,
  };
  return {
    entry: {
      markdown: extracted.markdown,
      title: extracted.title,
      metadata: extractionMetadataFromHtml({
        markdownChars: extracted.markdown.length,
        contentType: opts.contentType,
        finalUrl: opts.finalUrl,
        attempts: [attempt],
        discoveredLinks: extracted.links,
        pageMetadata: extracted.metadata,
      }),
    },
    attempt,
  };
}

function failedDirectAttempt(
  method: string,
  note: string,
): DirectExtractionOutcome {
  return {
    entry: null,
    attempt: { method, ok: false, note },
  };
}

function isLikelyPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.pdf$/i.test(parsed.pathname);
  } catch {
    return /\.pdf(?:$|[?#])/i.test(url);
  }
}

function isPdfContentType(contentType: string | undefined): boolean {
  return /\bapplication\/pdf\b/i.test(contentType ?? "");
}

function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  return /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

function isPdfBytes(data: Uint8Array): boolean {
  if (data.byteLength < PDF_MAGIC.length) return false;
  const prefix = new TextDecoder("ascii").decode(data.slice(0, PDF_MAGIC.length));
  return prefix === PDF_MAGIC;
}

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function titleFromPdfUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
    return filename || url;
  } catch {
    return url;
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
  ctx: ResearchLoopContext,
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

async function fetchSourceDocument(
  ctx: ResearchLoopContext,
  url: string,
  sourceId: string,
): Promise<SourceDocument | null> {
  ctx.emit({ type: "fetching", url });

  const { markdown, title, metadata } = await sourceWithCache(ctx, url);
  if (!markdown) {
    ctx.caches.sources.delete(url);
    const error = sourceErrorFromMetadata(metadata);
    ctx.emit({
      type: "source_error",
      url,
      error,
    });
    return null;
  }

  const resolvedTitle = title ?? url;
  const quality = assessSourceQuality(markdown, resolvedTitle, metadata);
  if (quality.fatalError) {
    ctx.caches.sources.delete(url);
    ctx.emit({
      type: "source_error",
      url,
      error: quality.fatalError,
    });
    return null;
  }
  const metadataWithQuality =
    quality.warnings.length === 0
      ? metadata
      : {
          ...metadata,
          qualityWarnings: [
            ...(metadata.qualityWarnings ?? []),
            ...quality.warnings,
          ],
        };
  const stored = storeMarkdown(markdown);
  const document = createSourceDocument(
    url,
    resolvedTitle,
    stored.markdown,
    metadataWithQuality,
    stored.originalChars,
    sourceId,
    normalizeFetchUrl(url),
  );
  ctx.fetchedSources.push({
    url,
    title: resolvedTitle,
    sourceId: document.sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  ctx.sourceDocuments.set(normalizeFetchUrl(url), document);

  ctx.emit({
    type: "source_fetched",
    url,
    title: resolvedTitle,
    method: document.metadata.method,
    markdownChars: document.metadata.markdownChars,
    attempts: document.metadata.attempts,
    qualityWarnings: document.metadata.qualityWarnings,
  });

  return document;
}

function summaryText(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function shouldSummarizeSource(
  ctx: ResearchLoopContext,
  document: SourceDocument,
  offset: number,
): boolean {
  if (offset > 0) return false;
  if (!ctx.query?.trim()) return false;
  if (document.markdown.length <= SUMMARY_MIN_SOURCE_CHARS) return false;
  const isDiscoveryPage =
    document.metadata.qualityWarnings?.some((warning) =>
      warning.startsWith("search_listing_page"),
    ) ?? false;
  return !isDiscoveryPage;
}

async function computeSourceSummary(
  ctx: ResearchLoopContext,
  document: SourceDocument,
  query: string,
): Promise<string> {
  const model = ctx.summaryModel ?? ctx.model;
  const resp = await model.step({
    system: FETCH_SUMMARY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: fetchSummaryPrompt({
          query,
          title: document.title,
          url: document.url,
          content: document.markdown.slice(0, SUMMARY_INPUT_CHARS),
        }),
      },
    ],
    maxTokens: SUMMARY_MAX_TOKENS,
    signal: ctx.signal,
  });
  return summaryText(resp.content);
}

async function getSourceSummary(
  ctx: ResearchLoopContext,
  document: SourceDocument,
  query: string,
): Promise<string | null> {
  const key = `${query}\u0000${document.canonicalUrl}`;
  let summaryPromise = ctx.caches.summaries.get(key);
  if (!summaryPromise) {
    summaryPromise = computeSourceSummary(ctx, document, query);
    ctx.caches.summaries.set(key, summaryPromise);
  }
  try {
    const summary = await summaryPromise;
    if (!summary) {
      ctx.caches.summaries.delete(key);
      return null;
    }
    return summary;
  } catch {
    ctx.caches.summaries.delete(key);
    return null;
  }
}

async function renderFetchOutput(
  ctx: ResearchLoopContext,
  document: SourceDocument,
  offset: number,
  maxChars: number,
): Promise<string> {
  const query = ctx.query?.trim();
  if (!query || !shouldSummarizeSource(ctx, document, offset)) {
    return formatFetchResult(document, offset, maxChars);
  }
  const summary = await getSourceSummary(ctx, document, query);
  if (summary === null) return formatFetchResult(document, offset, maxChars);
  return formatSourceSummary(document, summary);
}

export async function execFetch(
  args: FetchToolInput,
  ctx: ResearchLoopContext,
): Promise<FetchOutcome> {
  const offset = readOffset(args);
  if (typeof offset === "string") return { text: offset };
  const maxChars = readMaxChars(args, ctx);
  if (typeof maxChars === "string") return { text: maxChars };

  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl);
  if (validationError) return { text: validationError };
  const normalizedUrl = normalizeFetchUrl(requestedUrl);
  const existing = findSourceDocumentByUrl(ctx, normalizedUrl);
  if (existing) {
    return { text: formatFetchResult(existing, offset, maxChars) };
  }

  ctx.abort();

  let fetchedThisCall = false;
  let documentPromise = ctx.sourceReservations.documents.get(normalizedUrl);
  if (!documentPromise) {
    const reservation = reserveSource(ctx, requestedUrl);
    if (typeof reservation === "string") return { text: reservation };
    const url = reservation.url;
    fetchedThisCall = true;
    documentPromise = fetchSourceDocument(ctx, url, reservation.sourceId).finally(() => {
      ctx.sourceReservations.documents.delete(normalizedUrl);
      releaseSourceReservation(ctx, reservation);
    });
    ctx.sourceReservations.documents.set(normalizedUrl, documentPromise);
  }

  try {
    const document = await documentPromise;
    if (!document) {
      return { text: "Fetch failed: no content fetched." };
    }

    return {
      fetchedUrl: fetchedThisCall ? document.url : undefined,
      text: await renderFetchOutput(ctx, document, offset, maxChars),
    };
  } catch (err) {
    ctx.caches.sources.delete(normalizedUrl);
    const message = errorMessage(err);
    ctx.emit({
      type: "source_error",
      url: normalizedUrl,
      error: message,
    });
    return { text: `Fetch error: ${message}` };
  }
}

function sourceErrorFromMetadata(metadata: SourceCacheEntry["metadata"]): string {
  const failedAttempts = metadata.attempts?.filter((attempt) => !attempt.ok) ?? [];
  const priorityAttempt =
    failedAttempts.find((attempt) => attempt.note.includes("blocked_or_challenge")) ??
    failedAttempts.at(-1);
  if (priorityAttempt) {
    const attempts = failedAttempts
      .map((attempt) => `${attempt.method}: ${attempt.note}`)
      .join(" | ");
    return `${priorityAttempt.note}; attempts: ${attempts}`;
  }
  return "empty_markdown: no content fetched";
}

function assessSourceQuality(
  markdown: string,
  title: string,
  metadata: SourceCacheEntry["metadata"],
): { fatalError?: string; warnings: string[] } {
  const trimmed = markdown.trim();
  const warnings: string[] = [];

  if (looksBlocked(`${title}\n${trimmed}`)) {
    warnings.push("blocked_or_challenge: fetched content looked blocked");
  }

  if (trimmed.length < MIN_SOURCE_MARKDOWN_CHARS) {
    return {
      fatalError: `thin_content: extracted only ${trimmed.length} chars`,
      warnings,
    };
  }

  const titleLooksLikeError = ERROR_TITLE_PATTERN.test(title);
  const hadHttpError = metadata.attempts?.some((attempt) =>
    /^http_error:/.test(attempt.note),
  );
  if (titleLooksLikeError && (trimmed.length < 500 || hadHttpError)) {
    warnings.push(`error_page: ${title} (${trimmed.length} chars)`);
  }

  if (trimmed.length < THIN_SOURCE_MARKDOWN_CHARS) {
    warnings.push("thin_content");
  }
  if (SEARCH_LISTING_TITLE_PATTERN.test(title)) {
    warnings.push("search_listing_page");
  }

  return { warnings };
}
