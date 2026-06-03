import type { ResearchCtx, SourceCacheEntry } from "./runtime.js";
import type { SourceDocument, SourceExtractionAttempt } from "./sources.js";
import {
  createSourceDocument,
  extractionMetadataFromHtml,
  extractionMetadataFromPdf,
  extractionMetadataFromText,
  findSourceDocumentByUrl,
  formatSourceCard,
  storeMarkdown,
} from "./source-documents.js";
import { extractSourceWithBrowser } from "./browser-extract.js";
import { errorMessage } from "./errors.js";
import { extractPdfText } from "./pdf-extract.js";
import { looksBlocked } from "./steel.js";
import {
  DEFAULT_FETCH_PREVIEW_CHARS,
  MAX_FETCH_PREVIEW_CHARS,
} from "./tool-contract.js";
import { htmlToMarkdown } from "./html-extract.js";
import { normalizeUrlForSource } from "./url.js";

export interface FetchToolInput {
  url?: string;
  urls?: string[];
  preview_chars?: number;
  max_chars?: number;
}

interface FetchOutcome {
  text: string;
  fetchedUrl?: string;
  fetchedUrls?: string[];
}

interface DirectExtractionOutcome {
  entry: SourceCacheEntry | null;
  attempt: SourceExtractionAttempt;
}

interface SourceReservation {
  url: string;
  sourceId: string;
}

const DIRECT_PDF_MAX_BYTES = 25 * 1024 * 1024;
const DIRECT_HTML_MAX_BYTES = 5 * 1024 * 1024;
const DIRECT_FETCH_TIMEOUT_MS = 15_000;
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
const FETCH_MANY_MAX_URLS = 12;

function totalSourceSlots(ctx: ResearchCtx): number {
  return (
    ctx.store.fetchedSources.length + ctx.store.sourceReservations.sourceSlots
  );
}

function reserveSource(
  ctx: ResearchCtx,
  url: string,
): SourceReservation | string {
  const normalizedUrl = normalizeUrlForSource(url);
  if (ctx.store.sourceReservations.urls.has(normalizedUrl)) {
    return `Already being fetched: ${url}. Try another source or continue after this fetch completes.`;
  }
  if (totalSourceSlots(ctx) >= ctx.config.sourceCap) {
    return `Fetched source cap reached (${ctx.config.sourceCap}). Search or read stored sources, or write the report.`;
  }

  ctx.store.sourceReservations.urls.add(normalizedUrl);
  ctx.store.sourceReservations.sourceSlots++;
  return {
    url: normalizedUrl,
    sourceId: `source_${ctx.store.sourceReservations.nextSourceNumber++}`,
  };
}

function releaseSourceReservation(
  ctx: ResearchCtx,
  reservation: SourceReservation,
): void {
  ctx.store.sourceReservations.urls.delete(reservation.url);
  ctx.store.sourceReservations.sourceSlots = Math.max(
    0,
    ctx.store.sourceReservations.sourceSlots - 1,
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
  ctx: ResearchCtx,
  url: string,
): Promise<SourceCacheEntry> {
  let sourcePromise = ctx.store.caches.sources.get(url);
  if (!sourcePromise) {
    sourcePromise = extractSourceWithFallbacks(ctx, url);
    ctx.store.caches.sources.set(url, sourcePromise);
  }

  try {
    return await sourcePromise;
  } catch (err) {
    ctx.store.caches.sources.delete(url);
    throw err;
  }
}

async function extractSourceWithFallbacks(
  ctx: ResearchCtx,
  url: string,
): Promise<SourceCacheEntry> {
  const attempts: SourceExtractionAttempt[] = [];
  const direct = await tryDirectExtraction(ctx, url);
  attempts.push(direct.attempt);
  if (direct.entry) return direct.entry;

  return extractSourceWithBrowser(ctx, url, attempts);
}

async function tryDirectExtraction(
  ctx: ResearchCtx,
  url: string,
): Promise<DirectExtractionOutcome> {
  try {
    const timeout = AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: ctx.deps.signal
        ? AbortSignal.any([ctx.deps.signal, timeout])
        : timeout,
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
    const maxBytes =
      isLikelyPdfUrl(url) || isPdfContentType(contentType)
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

    if (!contentType && looksLikeDirectText(data)) {
      return extractDirectText(data, { contentType, finalUrl });
    }

    if (isHtmlContentType(contentType)) {
      return extractDirectHtml(data, { contentType, finalUrl });
    }

    if (isDirectTextContentType(contentType) || looksLikeDirectText(data)) {
      return extractDirectText(data, { contentType, finalUrl });
    }

    return failedDirectAttempt(
      "direct_http",
      contentType
        ? `unsupported_content_type: direct response was ${contentType}`
        : "unsupported_content_type: direct response was not HTML, PDF, JSON, XML, or text",
    );
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return failedDirectAttempt(
      "direct_http",
      `network_error: direct fetch failed: ${errorMessage(err)}`,
    );
  }
}

function extractDirectText(
  data: Uint8Array,
  opts: { contentType?: string; finalUrl: string },
): DirectExtractionOutcome {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (looksBlocked(decoded)) {
    return failedDirectAttempt(
      "text_direct",
      "blocked_or_challenge: direct text looked blocked",
    );
  }

  const parsed = normalizeDirectText(decoded, opts.contentType);
  const markdown = parsed.markdown.trim();
  if (markdown.length < DIRECT_HTML_MIN_CHARS) {
    return failedDirectAttempt(
      parsed.method,
      `thin_content: direct text extracted ${markdown.length} chars`,
    );
  }

  const attempt = {
    method: parsed.method,
    ok: true,
    note: `${parsed.method}: extracted ${markdown.length} text chars`,
  };
  return {
    entry: {
      markdown,
      title: titleFromTextUrl(opts.finalUrl),
      metadata: extractionMetadataFromText({
        markdownChars: markdown.length,
        method: parsed.method,
        contentType: opts.contentType,
        finalUrl: opts.finalUrl,
        attempts: [attempt],
      }),
    },
    attempt,
  };
}

async function extractDirectPdf(
  data: Uint8Array,
  opts: { contentType?: string; finalUrl: string },
): Promise<DirectExtractionOutcome> {
  try {
    const extracted = await extractPdfText(data);
    const markdown = extracted.text.trim();
    if (!markdown) {
      return failedDirectAttempt(
        "pdf_direct",
        "pdf_no_text: PDF extraction produced no text",
      );
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
    return failedDirectAttempt(
      "html_direct",
      "blocked_or_challenge: direct HTML looked blocked",
    );
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

function isJsonContentType(contentType: string | undefined): boolean {
  return /\b(?:application|text)\/(?:[\w.+-]+\+)?json\b/i.test(
    contentType ?? "",
  );
}

function isXmlContentType(contentType: string | undefined): boolean {
  return /\b(?:application|text)\/(?:[\w.+-]+\+)?xml\b/i.test(
    contentType ?? "",
  );
}

function isPlainTextContentType(contentType: string | undefined): boolean {
  return /\btext\/(?:plain|csv|tab-separated-values|markdown)\b/i.test(
    contentType ?? "",
  );
}

function isDirectTextContentType(contentType: string | undefined): boolean {
  return (
    isJsonContentType(contentType) ||
    isXmlContentType(contentType) ||
    isPlainTextContentType(contentType)
  );
}

function looksLikeDirectText(data: Uint8Array): boolean {
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(data.slice(0, 512))
    .trimStart();
  return (
    prefix.startsWith("{") ||
    prefix.startsWith("[") ||
    prefix.startsWith("<?xml") ||
    /^PMID-|\b[A-Z]{2,}-\s/.test(prefix)
  );
}

function normalizeDirectText(
  text: string,
  contentType: string | undefined,
): {
  markdown: string;
  method: "json_direct" | "text_direct" | "xml_direct";
} {
  const trimmed = text.trim();
  if (isJsonContentType(contentType) || /^[\[{]/.test(trimmed)) {
    try {
      return {
        markdown: JSON.stringify(JSON.parse(trimmed), null, 2),
        method: "json_direct",
      };
    } catch {
      return { markdown: trimmed, method: "text_direct" };
    }
  }
  if (isXmlContentType(contentType) || /^<\??xml\b/i.test(trimmed)) {
    return { markdown: trimmed, method: "xml_direct" };
  }
  return { markdown: trimmed, method: "text_direct" };
}

function isPdfBytes(data: Uint8Array): boolean {
  if (data.byteLength < PDF_MAGIC.length) return false;
  const prefix = new TextDecoder("ascii").decode(
    data.slice(0, PDF_MAGIC.length),
  );
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
    const filename = decodeURIComponent(
      pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    return filename || url;
  } catch {
    return url;
  }
}

function titleFromTextUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = decodeURIComponent(
      parsed.pathname.split("/").filter(Boolean).at(-1) ?? "",
    );
    return filename || parsed.hostname || url;
  } catch {
    return url;
  }
}

function readPreviewChars(args: FetchToolInput): number | string {
  const raw =
    args.preview_chars ?? args.max_chars ?? DEFAULT_FETCH_PREVIEW_CHARS;
  const previewChars = Math.min(
    MAX_FETCH_PREVIEW_CHARS,
    Math.max(1, Math.floor(Number(raw))),
  );
  if (!Number.isFinite(previewChars)) {
    return "Error: preview_chars must be a number.";
  }
  return previewChars;
}

async function fetchSourceDocument(
  ctx: ResearchCtx,
  url: string,
  sourceId: string,
): Promise<SourceDocument | null> {
  ctx.scope.emit({ type: "fetching", url });

  const { markdown, title, metadata } = await sourceWithCache(ctx, url);
  if (!markdown) {
    ctx.store.caches.sources.delete(url);
    const error = sourceErrorFromMetadata(metadata);
    ctx.scope.emit({
      type: "source_error",
      url,
      error,
    });
    return null;
  }

  const resolvedTitle = title ?? url;
  const quality = assessSourceQuality(markdown, resolvedTitle, metadata);
  if (quality.fatalError) {
    ctx.store.caches.sources.delete(url);
    ctx.scope.emit({
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
    normalizeUrlForSource(url),
  );
  ctx.store.fetchedSources.push({
    url,
    title: resolvedTitle,
    sourceId: document.sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  ctx.store.sourceDocuments.set(normalizeUrlForSource(url), document);
  ctx.store.sourceDocumentsById.set(document.sourceId, document);

  ctx.scope.emit({
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

export async function execFetch(
  args: FetchToolInput,
  ctx: ResearchCtx,
): Promise<FetchOutcome> {
  if (Array.isArray(args.urls)) {
    return fetchManyUrls(args, ctx);
  }

  const previewChars = readPreviewChars(args);
  if (typeof previewChars === "string") return { text: previewChars };

  const requestedUrl = String(args.url ?? "").trim();
  const validationError = validateHttpUrl(requestedUrl);
  if (validationError) return { text: validationError };
  const normalizedUrl = normalizeUrlForSource(requestedUrl);
  const existing = findSourceDocumentByUrl(ctx, normalizedUrl);
  if (existing) {
    return { text: formatSourceCard(existing, previewChars) };
  }

  ctx.deps.abort();

  let fetchedThisCall = false;
  let documentPromise =
    ctx.store.sourceReservations.documents.get(normalizedUrl);
  if (!documentPromise) {
    const reservation = reserveSource(ctx, requestedUrl);
    if (typeof reservation === "string") return { text: reservation };
    const url = reservation.url;
    fetchedThisCall = true;
    documentPromise = fetchSourceDocument(
      ctx,
      url,
      reservation.sourceId,
    ).finally(() => {
      ctx.store.sourceReservations.documents.delete(normalizedUrl);
      releaseSourceReservation(ctx, reservation);
    });
    ctx.store.sourceReservations.documents.set(normalizedUrl, documentPromise);
  }

  try {
    const document = await documentPromise;
    if (!document) {
      return { text: "Fetch failed: no content fetched." };
    }

    return {
      fetchedUrl: fetchedThisCall ? document.url : undefined,
      text: formatSourceCard(document, previewChars),
    };
  } catch (err) {
    ctx.store.caches.sources.delete(normalizedUrl);
    const message = errorMessage(err);
    ctx.scope.emit({
      type: "source_error",
      url: normalizedUrl,
      error: message,
    });
    return { text: `Fetch error: ${message}` };
  }
}

async function fetchManyUrls(
  args: FetchToolInput,
  ctx: ResearchCtx,
): Promise<FetchOutcome> {
  const previewChars = readPreviewChars(args);
  if (typeof previewChars === "string") return { text: previewChars };

  const urls = Array.isArray(args.urls)
    ? [
        ...new Set(
          args.urls.map((url) => String(url ?? "").trim()).filter(Boolean),
        ),
      ]
    : [];
  if (urls.length === 0) {
    return {
      text: "Error: fetch requires a non-empty `urls` array (or a single `url`).",
    };
  }
  if (urls.length > FETCH_MANY_MAX_URLS) {
    return {
      text: `Error: fetch accepts at most ${FETCH_MANY_MAX_URLS} URLs per call.`,
    };
  }

  const outcomes = await Promise.all(
    urls.map(async (url) => {
      const validationError = validateHttpUrl(url);
      if (validationError) return { url, error: validationError };
      const out = await execFetch({ url, preview_chars: previewChars }, ctx);
      const parsed = parseJsonResult(out.text);
      if (!parsed.ok) return { url, error: out.text };
      return {
        url,
        ...(out.fetchedUrl ? { fetched_url: out.fetchedUrl } : {}),
        result: parsed.value,
      };
    }),
  );
  const fetchedUrls = outcomes
    .map((outcome) =>
      "fetched_url" in outcome ? String(outcome.fetched_url) : undefined,
    )
    .filter((url): url is string => Boolean(url));

  return {
    fetchedUrls,
    text: JSON.stringify({ sources: outcomes }, null, 2),
  };
}

function parseJsonResult(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function sourceErrorFromMetadata(
  metadata: SourceCacheEntry["metadata"],
): string {
  const failedAttempts =
    metadata.attempts?.filter((attempt) => !attempt.ok) ?? [];
  const priorityAttempt =
    failedAttempts.find((attempt) =>
      attempt.note.includes("blocked_or_challenge"),
    ) ?? failedAttempts.at(-1);
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
