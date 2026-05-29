import type { ResearchLoopContext } from "./runtime.js";
import { extractCurrentPage, navigateToUrl } from "./browser-extract.js";
import {
  createSourceDocument,
  extractionMetadataFromBrowser,
  findSourceDocumentByUrl,
  formatFetchResult,
  storeMarkdown,
} from "./source-documents.js";
import { htmlToMarkdown } from "./html-extract.js";
import { DEFAULT_FETCH_CHARS } from "./tool-contract.js";
import { normalizeFetchUrl } from "./fetch-tool.js";

const BROWSER_CDP_OUTPUT_CHARS = 60_000;
const BROWSER_CDP_ALLOWED_PREFIXES = [
  "Accessibility.",
  "DOM.",
  "Network.",
  "Page.",
  "Runtime.",
  "Target.",
];
const BROWSER_CDP_DENIED_METHODS = new Set([
  "Network.clearBrowserCache",
  "Network.clearBrowserCookies",
  "Page.setDownloadBehavior",
]);

export interface BrowserOpenToolInput {
  url?: string;
}

export interface BrowserCdpToolInput {
  method?: string;
  params?: Record<string, unknown>;
  timeout_ms?: number;
}

export interface BrowserExtractToolInput {
  max_chars?: number;
}

export async function execBrowserOpen(
  args: BrowserOpenToolInput,
  ctx: ResearchLoopContext,
): Promise<string> {
  const lease = await ensureBrowserLease(ctx);
  const url = String(args.url ?? "").trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      return `Error: browser_open url must be absolute http(s): ${url}`;
    }
    await navigateToUrl(lease.resource, url);
  }
  const snapshot = await extractCurrentPage(lease.resource);
  return JSON.stringify(
    {
      browser: "open",
      url: snapshot.url,
      title: snapshot.title,
    },
    null,
    2,
  );
}

export async function execBrowserCdp(
  args: BrowserCdpToolInput,
  ctx: ResearchLoopContext,
): Promise<string> {
  const method = String(args.method ?? "").trim();
  if (!method) return "Error: browser_cdp requires `method`.";
  const policyError = validateCdpMethod(method);
  if (policyError) return policyError;
  const lease = await ensureBrowserLease(ctx);
  const timeoutMs =
    args.timeout_ms === undefined
      ? undefined
      : Math.max(1, Math.floor(Number(args.timeout_ms)));
  if (args.timeout_ms !== undefined && !Number.isFinite(timeoutMs)) {
    return "Error: timeout_ms must be a finite positive number.";
  }
  const result = await lease.resource.client.send(
    method,
    isPlainRecord(args.params) ? args.params : {},
    {
      ...(lease.resource.cdpSessionId ? { sessionId: lease.resource.cdpSessionId } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  return truncateToolResult(JSON.stringify(result, null, 2));
}

export async function execBrowserExtract(
  args: BrowserExtractToolInput,
  ctx: ResearchLoopContext,
): Promise<string> {
  if (!ctx.browserSessionLease) {
    return "Error: browser_extract requires an open browser session. Call browser_open first.";
  }
  const maxChars = readMaxChars(args, ctx);
  if (typeof maxChars === "string") return maxChars;
  const snapshot = await extractCurrentPage(ctx.browserSessionLease.resource);
  const normalizedUrl = normalizeFetchUrl(snapshot.url);
  const existing = findSourceDocumentByUrl(ctx, normalizedUrl);
  if (existing) return formatFetchResult(existing, 0, maxChars);
  if (ctx.fetchedSources.length >= ctx.sourceCap) {
    return `Fetched source cap reached (${ctx.sourceCap}). Continue reading fetched URLs or write the report.`;
  }

  const extracted = htmlToMarkdown(snapshot.html, snapshot.url);
  const stored = storeMarkdown(extracted.markdown);
  const sourceId = `source_${ctx.sourceReservations.nextSourceNumber++}`;
  const document = createSourceDocument(
    snapshot.url,
    extracted.title || snapshot.title || snapshot.url,
    stored.markdown,
    extractionMetadataFromBrowser({
      markdownChars: extracted.markdown.length,
      finalUrl: snapshot.url,
      attempts: [
        {
          method: "browser_extract",
          ok: Boolean(extracted.markdown),
          note: `browser_extract: extracted ${extracted.markdown.length} markdown chars`,
        },
      ],
      discoveredLinks: extracted.links,
      pageMetadata: extracted.metadata,
    }),
    stored.originalChars,
    sourceId,
    normalizedUrl,
  );
  ctx.fetchedSources.push({
    url: snapshot.url,
    title: document.title,
    sourceId: document.sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  ctx.sourceDocuments.set(normalizedUrl, document);
  ctx.emit({
    type: "source_fetched",
    url: snapshot.url,
    title: document.title,
    method: document.metadata.method,
    markdownChars: document.metadata.markdownChars,
    attempts: document.metadata.attempts,
    qualityWarnings: document.metadata.qualityWarnings,
  });
  return formatFetchResult(document, 0, maxChars);
}

export async function closeBrowserLease(ctx: ResearchLoopContext): Promise<void> {
  const lease = ctx.browserSessionLease;
  if (!lease) return;
  ctx.browserSessionLease = undefined;
  await lease.release();
}

async function ensureBrowserLease(ctx: ResearchLoopContext) {
  if (ctx.browserSessionLease) return ctx.browserSessionLease;
  if (!ctx.browserSessionPool) {
    return Promise.reject(new Error("Browser session pool is unavailable"));
  }
  ctx.browserSessionLease = await ctx.browserSessionPool.acquire();
  return ctx.browserSessionLease;
}

function validateCdpMethod(method: string): string | null {
  if (BROWSER_CDP_DENIED_METHODS.has(method)) {
    return `Error: CDP method is not allowed: ${method}`;
  }
  if (!BROWSER_CDP_ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return `Error: CDP method is not allowed: ${method}`;
  }
  if (
    /(?:Cookie|Storage|Download|Permission|FileSystem|Browser\.)/i.test(method)
  ) {
    return `Error: CDP method is not allowed: ${method}`;
  }
  return null;
}

function truncateToolResult(text: string): string {
  if (text.length <= BROWSER_CDP_OUTPUT_CHARS) return text;
  return `${text.slice(0, BROWSER_CDP_OUTPUT_CHARS)}\n... truncated ${text.length - BROWSER_CDP_OUTPUT_CHARS} chars`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMaxChars(
  args: BrowserExtractToolInput,
  ctx: ResearchLoopContext,
): number | string {
  const raw = args.max_chars ?? ctx.fetchSnippetChars ?? DEFAULT_FETCH_CHARS;
  const maxChars = Math.max(1, Math.floor(Number(raw)));
  if (!Number.isFinite(maxChars)) {
    return "Error: max_chars must be a number.";
  }
  return maxChars;
}
