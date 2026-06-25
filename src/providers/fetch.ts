import type { Dispatcher } from "undici";
import { sleep, withTimeout } from "../async.js";
import { readEnv } from "../env.js";
import { errorMessage } from "../errors.js";
import { htmlToMarkdown } from "../html-extract.js";
import { extractPdfText } from "../pdf-extract.js";
import { createRobotsCache, type RobotsCache } from "../robots.js";
import { guardRedirect as guardRedirectUrl } from "../safety.js";
import {
  extractionMetadataFromExa,
  extractionMetadataFromHtml,
  extractionMetadataFromPdf,
  extractionMetadataFromScrape,
  extractionMetadataFromText,
  extractionMetadataFromYoutube,
} from "../source-documents.js";
import type {
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "../sources.js";
import {
  fetchYoutubeTranscript,
  youtubeTranscriptToMarkdown,
  youtubeVideoId,
} from "../youtube.js";

const DIRECT_PDF_MAX_BYTES = 25 * 1024 * 1024;
const DIRECT_HTML_MAX_BYTES = 5 * 1024 * 1024;
const DIRECT_FETCH_TIMEOUT_MS = 15_000;
const SCRAPE_TIMEOUT_MS = 30_000;
const DIRECT_HTML_MIN_CHARS = 100;
const PDF_MAGIC = "%PDF";
const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; AtlasResearchBot/0.2; +https://github.com/steel-experiments/atlas)";
const ROBOTS_AGENT_TOKEN = "atlasresearchbot";
const STEEL_RETRY_MAX_ATTEMPTS = 5;

const ANTI_BOT_MARKERS = [
  "just a moment",
  "verifying you are human",
  "checking your browser",
  "enable javascript and cookies",
  "access denied",
  "captcha",
  "pardon our interruption",
  "unusual traffic from your computer network",
];

export function looksBlocked(text: string | undefined | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().slice(0, 4000);
  return ANTI_BOT_MARKERS.some((marker) => lower.includes(marker));
}

const BLOCK_MARKER_EXEMPT_CHARS = 2_000;

export function looksBlockedPage(markdown: string, raw?: string): boolean {
  if (markdown.length >= BLOCK_MARKER_EXEMPT_CHARS) return false;
  return looksBlocked(markdown) || looksBlocked(raw);
}

export interface FetchedPage {
  finalUrl: string;
  title: string | null;
  markdown: string;
  metadata: SourceExtractionMetadata;
  renderedWith: string;
}

export type FetchAttempt =
  | { ok: true; page: FetchedPage; attempt: SourceExtractionAttempt }
  | { ok: false; attempt: SourceExtractionAttempt; escalate: boolean };

export interface FetchRequest {
  url: string;
  signal?: AbortSignal | undefined;
  onRateLimit?: ((retryAfterSeconds: number) => void) | undefined;
  guardRedirect?:
    | ((url: string) => Promise<{ ok: true } | { ok: false; reason: string }>)
    | undefined;
  dispatcher?: Dispatcher | undefined;
}

export interface FetchProvider {
  readonly id: string;
  fetch(req: FetchRequest): Promise<FetchAttempt>;
}

function failed(method: string, note: string, escalate = true): FetchAttempt {
  return { ok: false, attempt: { method, ok: false, note }, escalate };
}

export function isLikelyPdfUrl(url: string): boolean {
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

function isPdfBytes(data: Uint8Array): boolean {
  if (data.byteLength < PDF_MAGIC.length) return false;
  return (
    new TextDecoder("ascii").decode(data.slice(0, PDF_MAGIC.length)) ===
    PDF_MAGIC
  );
}

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function titleFromUrl(url: string): string {
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

function normalizeDirectText(
  text: string,
  contentType: string | undefined,
): { markdown: string; method: "json_direct" | "text_direct" | "xml_direct" } {
  const trimmed = text.trim();
  if (isJsonContentType(contentType) || /^[[{]/.test(trimmed)) {
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

export function basicFetch(): FetchProvider {
  const robots = createRobotsCache({
    agentToken: ROBOTS_AGENT_TOKEN,
    userAgent: FETCH_USER_AGENT,
  });
  const domainTails = new Map<string, Promise<unknown>>();
  const serialize = <T>(host: string, task: () => Promise<T>): Promise<T> => {
    const prev = domainTails.get(host) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.then(
      () => {},
      () => {},
    );
    domainTails.set(host, tail);
    void tail.then(() => {
      if (domainTails.get(host) === tail) domainTails.delete(host);
    });
    return next;
  };

  return {
    id: "basic",
    fetch(req) {
      let host: string;
      try {
        host = new URL(req.url).host.toLowerCase();
      } catch {
        return Promise.resolve(
          failed("direct_http", `bad_url: not a valid URL: ${req.url}`, false),
        );
      }
      return serialize(host, () => directFetch(req, robots));
    },
  };
}

class ResponseTooLargeError extends Error {}

async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new ResponseTooLargeError();
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const MAX_REDIRECT_HOPS = 5;

async function directFetch(
  { url, signal, guardRedirect, dispatcher }: FetchRequest,
  robots: RobotsCache,
): Promise<FetchAttempt> {
  if (!guardRedirect) {
    const initial = await guardRedirectUrl(url, {});
    if (!initial.ok) {
      return failed(
        "direct_http",
        `blocked_url: fetch of ${url} blocked: ${initial.reason}`,
        false,
      );
    }
  }
  if (youtubeVideoId(url)) {
    const transcript = await tryYoutubeTranscript(url, signal);
    if (transcript) return transcript;
  }
  let currentUrl = url;
  let response: Response;
  for (let hop = 0; ; hop++) {
    if (!(await robots.allows(currentUrl, signal, dispatcher))) {
      return failed(
        "direct_http",
        "robots_disallowed: robots.txt disallows direct fetching of this URL",
      );
    }
    try {
      const timeout = AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS);
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          accept: "application/pdf,*/*;q=0.8",
          "user-agent": FETCH_USER_AGENT,
        },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      if (signal?.aborted) throw err;
      return failed(
        "direct_http",
        `network_error: direct fetch failed: ${errorMessage(err)}`,
      );
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECT_HOPS) {
        return failed(
          "direct_http",
          `too_many_redirects: gave up after ${MAX_REDIRECT_HOPS} redirects`,
        );
      }
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        return failed(
          "direct_http",
          `bad_redirect: invalid redirect location: ${location}`,
          false,
        );
      }
      const verdict = guardRedirect
        ? await guardRedirect(next)
        : await guardRedirectUrl(next, {});
      if (!verdict.ok) {
        return failed(
          "direct_http",
          `blocked_redirect: redirect to ${next} blocked: ${verdict.reason}`,
          false,
        );
      }
      currentUrl = next;
      continue;
    }
    break;
  }
  if (!response.ok) {
    return failed(
      "direct_http",
      `http_error: direct fetch returned HTTP ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const contentLength = readContentLength(response.headers);
  const maxBytes =
    isLikelyPdfUrl(currentUrl) || isPdfContentType(contentType)
      ? DIRECT_PDF_MAX_BYTES
      : DIRECT_HTML_MAX_BYTES;
  if (contentLength !== undefined && contentLength > maxBytes) {
    return failed(
      "direct_http",
      `too_large: direct response is too large (${contentLength} bytes)`,
      false,
    );
  }
  let data: Uint8Array;
  try {
    data = await readCappedBytes(response, maxBytes);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof ResponseTooLargeError) {
      return failed(
        "direct_http",
        `too_large: direct response exceeded ${maxBytes} bytes`,
        false,
      );
    }
    return failed(
      "direct_http",
      `network_error: reading response failed: ${errorMessage(err)}`,
    );
  }

  const finalUrl = response.url || currentUrl;
  if (isPdfBytes(data) || isPdfContentType(contentType)) {
    return extractPdf(data, contentType, finalUrl, signal);
  }
  if (!contentType && looksLikeDirectText(data)) {
    return extractText(data, contentType, finalUrl);
  }
  if (isHtmlContentType(contentType)) {
    return extractHtml(data, contentType, finalUrl);
  }
  if (isDirectTextContentType(contentType) || looksLikeDirectText(data)) {
    return extractText(data, contentType, finalUrl);
  }
  return failed(
    "direct_http",
    contentType
      ? `unsupported_content_type: direct response was ${contentType}`
      : "unsupported_content_type: direct response was not HTML, PDF, JSON, XML, or text",
    false,
  );
}

function extractHtml(
  data: Uint8Array,
  contentType: string | undefined,
  finalUrl: string,
): FetchAttempt {
  const html = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const extracted = htmlToMarkdown(html, finalUrl);
  if (looksBlockedPage(extracted.markdown, html)) {
    return failed(
      "html_direct",
      "blocked_or_challenge: direct HTML looked blocked",
    );
  }
  if (extracted.markdown.length < DIRECT_HTML_MIN_CHARS) {
    return failed(
      "html_direct",
      `thin_content: direct HTML extracted ${extracted.markdown.length} chars`,
    );
  }
  const attempt: SourceExtractionAttempt = {
    method: "html_direct",
    ok: true,
    note: `html_direct: extracted ${extracted.markdown.length} text chars`,
  };
  return {
    ok: true,
    attempt,
    page: {
      finalUrl,
      title: extracted.title,
      markdown: extracted.markdown,
      renderedWith: "html_direct",
      metadata: extractionMetadataFromHtml({
        markdownChars: extracted.markdown.length,
        ...(contentType ? { contentType } : {}),
        finalUrl,
        attempts: [attempt],
        discoveredLinks: extracted.links,
        pageMetadata: extracted.metadata,
      }),
    },
  };
}

const YOUTUBE_TRANSCRIPT_MIN_CHARS = 40;

async function tryYoutubeTranscript(
  url: string,
  signal: AbortSignal | undefined,
): Promise<FetchAttempt | null> {
  let transcript: Awaited<ReturnType<typeof fetchYoutubeTranscript>>;
  try {
    transcript = await fetchYoutubeTranscript(url, { signal });
  } catch {
    return null;
  }
  if (!transcript) return null;
  const markdown = youtubeTranscriptToMarkdown(transcript).trim();
  if (markdown.length < YOUTUBE_TRANSCRIPT_MIN_CHARS) return null;
  const finalUrl = `https://www.youtube.com/watch?v=${transcript.videoId}`;
  const attempt: SourceExtractionAttempt = {
    method: "youtube_transcript",
    ok: true,
    note: `youtube_transcript: extracted ${markdown.length} text chars (${transcript.kind} ${transcript.languageCode}, ${transcript.segmentCount} segments)`,
  };
  return {
    ok: true,
    attempt,
    page: {
      finalUrl,
      title: transcript.title,
      markdown,
      renderedWith: "youtube_transcript",
      metadata: extractionMetadataFromYoutube({
        markdownChars: markdown.length,
        finalUrl,
        attempts: [attempt],
        ...(transcript.author ? { author: transcript.author } : {}),
        language: transcript.languageCode,
        ...(transcript.description
          ? { description: transcript.description }
          : {}),
      }),
    },
  };
}

const PDF_PARSE_TIMEOUT_MS = 30_000;

async function extractPdf(
  data: Uint8Array,
  contentType: string | undefined,
  finalUrl: string,
  signal: AbortSignal | undefined,
): Promise<FetchAttempt> {
  try {
    const extracted = await withTimeout(
      PDF_PARSE_TIMEOUT_MS,
      signal,
      "pdf_parse",
      () => extractPdfText(data),
    );
    const markdown = extracted.text.trim();
    if (!markdown) {
      return failed(
        "pdf_direct",
        "pdf_no_text: PDF extraction produced no text",
      );
    }
    const attempt: SourceExtractionAttempt = {
      method: "pdf_direct",
      ok: true,
      note: `pdf_direct: extracted ${markdown.length} text chars`,
    };
    return {
      ok: true,
      attempt,
      page: {
        finalUrl,
        title: titleFromUrl(finalUrl),
        markdown,
        renderedWith: "pdf_direct",
        metadata: extractionMetadataFromPdf({
          markdownChars: markdown.length,
          ...(contentType ? { contentType } : {}),
          finalUrl,
          attempts: [attempt],
        }),
      },
    };
  } catch (err) {
    return failed(
      "pdf_direct",
      `pdf_parse_error: PDF extraction failed: ${errorMessage(err)}`,
    );
  }
}

function extractText(
  data: Uint8Array,
  contentType: string | undefined,
  finalUrl: string,
): FetchAttempt {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const parsed = normalizeDirectText(decoded, contentType);
  const markdown = parsed.markdown.trim();
  if (looksBlockedPage(markdown, decoded)) {
    return failed(
      "text_direct",
      "blocked_or_challenge: direct text looked blocked",
    );
  }
  if (markdown.length < DIRECT_HTML_MIN_CHARS) {
    return failed(
      parsed.method,
      `thin_content: direct text extracted ${markdown.length} chars`,
    );
  }
  const attempt: SourceExtractionAttempt = {
    method: parsed.method,
    ok: true,
    note: `${parsed.method}: extracted ${markdown.length} text chars`,
  };
  return {
    ok: true,
    attempt,
    page: {
      finalUrl,
      title: titleFromUrl(finalUrl),
      markdown,
      renderedWith: parsed.method,
      metadata: extractionMetadataFromText({
        markdownChars: markdown.length,
        method: parsed.method,
        ...(contentType ? { contentType } : {}),
        finalUrl,
        attempts: [attempt],
      }),
    },
  };
}

export interface SteelOptions {
  apiKey?: string;
  baseUrl?: string;
  proxy?: boolean;
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
  const headers = (err as { headers?: unknown })?.headers;
  let headerValue: string | undefined;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    headerValue =
      (headers as { get: (key: string) => string | null }).get("retry-after") ??
      undefined;
  }
  if (headerValue) {
    const numeric = Number(headerValue);
    if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
  }
  const match = /try again in\s+(\d+(?:\.\d+)?)\s*seconds?/i.exec(message);
  if (match) return Math.ceil(Number(match[1]));
  return 15;
}

export function steel(opts: SteelOptions = {}): FetchProvider {
  const apiKey = opts.apiKey ?? readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY");
  if (!apiKey) {
    throw new Error(
      "steel() requires an apiKey (or set ATLAS_STEEL_API_KEY / STEEL_API_KEY)",
    );
  }
  const baseUrl =
    opts.baseUrl ?? readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL");
  let clientPromise: Promise<SteelScrapeClient> | null = null;
  const client = (): Promise<SteelScrapeClient> => {
    clientPromise ??= createSteelClient(apiKey, baseUrl);
    return clientPromise;
  };

  return {
    id: "steel",
    async fetch({ url, signal, onRateLimit }) {
      let response: SteelScrapeResponse;
      try {
        response = await withSteelRetry(
          () =>
            client().then((steelClient) =>
              steelClient.scrape(
                {
                  url,
                  format: isLikelyPdfUrl(url) ? ["html", "markdown"] : ["html"],
                  useProxy: opts.proxy ?? true,
                },
                { signal, timeout: SCRAPE_TIMEOUT_MS },
              ),
            ),
          signal,
          onRateLimit,
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        return failed(
          "steel_scrape",
          `network_error: steel scrape failed: ${errorMessage(err)}`,
          false,
        );
      }
      return steelAttemptFromResponse(response, url);
    },
  };
}

export interface SteelScrapeResponse {
  content?: { html?: string; markdown?: string };
  metadata?: { statusCode?: number; canonical?: string; title?: string };
}

export function steelAttemptFromResponse(
  response: SteelScrapeResponse,
  url: string,
): FetchAttempt {
  const status = response.metadata?.statusCode;
  if (status !== undefined && status >= 400) {
    return failed(
      "steel_scrape",
      `http_error: steel scrape returned HTTP ${status}`,
      false,
    );
  }
  const finalUrl = response.metadata?.canonical || url;
  const html = response.content?.html;
  if (html) {
    const extracted = htmlToMarkdown(html, finalUrl);
    if (
      !looksBlockedPage(extracted.markdown, html) &&
      extracted.markdown.length >= DIRECT_HTML_MIN_CHARS
    ) {
      const attempt: SourceExtractionAttempt = {
        method: "steel_scrape",
        ok: true,
        note: `steel_scrape: extracted ${extracted.markdown.length} text chars`,
      };
      return {
        ok: true,
        attempt,
        page: {
          finalUrl,
          title: extracted.title,
          markdown: extracted.markdown,
          renderedWith: "steel_scrape",
          metadata: extractionMetadataFromScrape({
            markdownChars: extracted.markdown.length,
            contentType: "text/html",
            finalUrl,
            attempts: [attempt],
            discoveredLinks: extracted.links,
            pageMetadata: extracted.metadata,
          }),
        },
      };
    }
  }
  const markdown = response.content?.markdown?.trim();
  if (
    markdown &&
    !looksBlockedPage(markdown) &&
    markdown.length >= DIRECT_HTML_MIN_CHARS
  ) {
    const attempt: SourceExtractionAttempt = {
      method: "steel_scrape",
      ok: true,
      note: `steel_scrape: extracted ${markdown.length} text chars`,
    };
    return {
      ok: true,
      attempt,
      page: {
        finalUrl,
        title: response.metadata?.title?.trim() || titleFromUrl(finalUrl),
        markdown,
        renderedWith: "steel_scrape",
        metadata: extractionMetadataFromScrape({
          markdownChars: markdown.length,
          finalUrl,
          attempts: [attempt],
        }),
      },
    };
  }
  return failed(
    "steel_scrape",
    "empty_content: steel scrape returned no usable content",
    false,
  );
}

interface SteelScrapeClient {
  scrape(
    params: { url: string; format: string[]; useProxy: boolean },
    options: { signal?: AbortSignal | undefined; timeout: number },
  ): Promise<SteelScrapeResponse>;
}

async function createSteelClient(
  apiKey: string,
  baseUrl: string | undefined,
): Promise<SteelScrapeClient> {
  const { default: Steel } = await import("steel-sdk");
  return new Steel({
    steelAPIKey: apiKey,
    baseURL: baseUrl,
    maxRetries: 0,
  }) as unknown as SteelScrapeClient;
}

async function withSteelRetry<T>(
  request: () => Promise<T>,
  signal: AbortSignal | undefined,
  onRateLimit: ((retryAfterSeconds: number) => void) | undefined,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      const retryAfterSeconds = parseRetryAfterSeconds(err);
      if (!retryAfterSeconds || attempt >= STEEL_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      onRateLimit?.(retryAfterSeconds);
      await sleep((retryAfterSeconds + 1) * 1000, signal);
    }
  }
}

const EXA_CONTENTS_MIN_CHARS = 200;

export function exaContents(
  opts: { apiKey?: string; baseUrl?: string } = {},
): FetchProvider {
  const apiKey = opts.apiKey ?? readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY");
  const endpoint = `${(opts.baseUrl ?? "https://api.exa.ai").replace(/\/+$/, "")}/contents`;
  return {
    id: "exa_contents",
    async fetch(req) {
      if (!apiKey) {
        return failed("exa_contents", "exa_contents: no Exa API key", true);
      }
      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          method: "POST",
          signal: req.signal ?? null,
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({
            urls: [req.url],
            text: true,
            livecrawl: "fallback",
          }),
          ...(req.dispatcher ? { dispatcher: req.dispatcher } : {}),
        } as RequestInit);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        return failed(
          "exa_contents",
          `exa_contents: ${errorMessage(err)}`,
          true,
        );
      }
      if (!resp.ok) {
        return failed(
          "exa_contents",
          `exa_contents: HTTP ${resp.status}`,
          true,
        );
      }
      let data: {
        results?: Array<{ title?: string; text?: string; url?: string }>;
      };
      try {
        data = (await resp.json()) as typeof data;
      } catch (err) {
        return failed(
          "exa_contents",
          `exa_contents: bad JSON: ${errorMessage(err)}`,
          true,
        );
      }
      const row = data.results?.[0];
      const markdown = (row?.text ?? "").trim();
      if (looksBlockedPage(markdown)) {
        return failed(
          "exa_contents",
          "blocked_or_challenge: exa contents looked blocked",
        );
      }
      if (markdown.length < EXA_CONTENTS_MIN_CHARS) {
        return failed(
          "exa_contents",
          `thin_content: exa contents returned ${markdown.length} chars`,
        );
      }
      const finalUrl = row?.url ?? req.url;
      const attempt: SourceExtractionAttempt = {
        method: "exa_contents",
        ok: true,
        note: `exa_contents: extracted ${markdown.length} text chars`,
      };
      return {
        ok: true,
        attempt,
        page: {
          finalUrl,
          title: row?.title ?? null,
          markdown,
          renderedWith: "exa_contents",
          metadata: extractionMetadataFromExa({
            markdownChars: markdown.length,
            finalUrl,
            attempts: [attempt],
          }),
        },
      };
    },
  };
}

export function defaultFetchProviders(): FetchProvider[] {
  const providers: FetchProvider[] = [basicFetch()];
  if (readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY")) {
    providers.push(exaContents());
  }
  if (readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY")) {
    providers.push(steel());
  }
  return providers;
}

export interface ChainFetchOutcome {
  page: FetchedPage | null;
  attempts: SourceExtractionAttempt[];
}

const FETCH_PROVIDER_TIMEOUT_MS = 120_000;
const FETCH_CHAIN_TIMEOUT_MS = 180_000;

const CHAIN_GOOD_CHARS = 600;

function pageScore(page: FetchedPage): number {
  const len = page.markdown.trim().length;
  return looksBlockedPage(page.markdown) ? len : len + 1_000_000;
}

function pageIsGood(page: FetchedPage): boolean {
  return (
    !looksBlockedPage(page.markdown) &&
    page.markdown.trim().length >= CHAIN_GOOD_CHARS
  );
}

export async function fetchThroughChain(
  chain: FetchProvider[],
  req: FetchRequest,
): Promise<ChainFetchOutcome> {
  const attempts: SourceExtractionAttempt[] = [];
  const deadlineAt = Date.now() + FETCH_CHAIN_TIMEOUT_MS;
  const runProvider = async (
    provider: FetchProvider,
  ): Promise<FetchAttempt> => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return failed(
        provider.id,
        "timeout: fetch chain deadline exhausted before this provider ran",
        false,
      );
    }
    try {
      return await withTimeout(
        Math.min(FETCH_PROVIDER_TIMEOUT_MS, remainingMs),
        req.signal,
        provider.id,
        (signal) => provider.fetch({ ...req, signal }),
      );
    } catch (err) {
      if (req.signal?.aborted) throw err;
      return failed(provider.id, `timeout: ${errorMessage(err)}`);
    }
  };
  const finalize = (page: FetchedPage): ChainFetchOutcome => {
    const merged = [
      ...attempts.filter((a) => !a.ok),
      ...(page.metadata.attempts ?? []),
    ];
    return {
      page: { ...page, metadata: { ...page.metadata, attempts: merged } },
      attempts: merged,
    };
  };
  if (chain.length === 0) return { page: null, attempts };
  const first = await runProvider(chain[0]);
  attempts.push(first.attempt);
  const firstPage = first.ok ? first.page : null;
  if (firstPage && pageIsGood(firstPage)) return finalize(firstPage);
  if (!first.ok && !first.escalate) return { page: null, attempts };
  const rest = chain.slice(1);
  const candidates: FetchedPage[] = firstPage ? [firstPage] : [];
  if (rest.length > 0) {
    const settled = await Promise.allSettled(rest.map((p) => runProvider(p)));
    for (const s of settled) {
      if (s.status === "fulfilled") {
        attempts.push(s.value.attempt);
        if (s.value.ok) candidates.push(s.value.page);
      } else if (req.signal?.aborted) {
        throw s.reason;
      }
    }
  }
  if (candidates.length === 0) return { page: null, attempts };
  const best = candidates.reduce((a, b) =>
    pageScore(b) > pageScore(a) ? b : a,
  );
  return finalize(best);
}
