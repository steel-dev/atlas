import type { ResearchCtx } from "./runtime.js";
import { extractCurrentPage, navigateToUrl } from "./browser-extract.js";
import {
  createSourceDocument,
  extractionMetadataFromBrowser,
  findSourceDocumentByUrl,
  formatSourceCard,
  storeMarkdown,
} from "./source-documents.js";
import { htmlToMarkdown } from "./html-extract.js";
import {
  DEFAULT_FETCH_PREVIEW_CHARS,
  MAX_FETCH_PREVIEW_CHARS,
} from "./tool-contract.js";
import { normalizeUrlForSource } from "./url.js";

const BROWSER_CDP_OUTPUT_CHARS = 12_000;
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
  ctx: ResearchCtx,
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
  ctx: ResearchCtx,
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
      ...(lease.resource.cdpSessionId
        ? { sessionId: lease.resource.cdpSessionId }
        : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  return truncateToolResult(JSON.stringify(result, null, 2));
}

export async function execBrowserExtract(
  args: BrowserExtractToolInput,
  ctx: ResearchCtx,
): Promise<string> {
  if (!ctx.scope.browserSessionLease) {
    return "Error: browser_extract requires an open browser session. Call browser_open first.";
  }
  const maxChars = readMaxChars(args);
  if (typeof maxChars === "string") return maxChars;
  const snapshot = await extractCurrentPage(
    ctx.scope.browserSessionLease.resource,
  );
  const normalizedUrl = normalizeUrlForSource(snapshot.url);
  const existing = findSourceDocumentByUrl(ctx, normalizedUrl);
  if (existing) return formatSourceCard(existing, maxChars);
  if (ctx.store.fetchedSources.length >= ctx.config.sourceCap) {
    return `Fetched source cap reached (${ctx.config.sourceCap}). Search or read stored sources, or write the report.`;
  }

  const extracted = htmlToMarkdown(snapshot.html, snapshot.url);
  const stored = storeMarkdown(extracted.markdown);
  const sourceId = `source_${ctx.store.sourceReservations.nextSourceNumber++}`;
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
  ctx.store.fetchedSources.push({
    url: snapshot.url,
    title: document.title,
    sourceId: document.sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  ctx.store.sourceDocuments.set(normalizedUrl, document);
  ctx.store.sourceDocumentsById.set(document.sourceId, document);
  ctx.store.claims.queue(ctx, document);
  ctx.scope.emit({
    type: "source_fetched",
    url: snapshot.url,
    title: document.title,
    method: document.metadata.method,
    markdownChars: document.metadata.markdownChars,
    attempts: document.metadata.attempts,
    qualityWarnings: document.metadata.qualityWarnings,
  });
  return formatSourceCard(document, maxChars);
}

async function ensureBrowserLease(ctx: ResearchCtx) {
  if (ctx.scope.browserSessionLease) return ctx.scope.browserSessionLease;
  ctx.scope.browserSessionLease = await ctx.deps.browserSessionPool.acquire();
  return ctx.scope.browserSessionLease;
}

function validateCdpMethod(method: string): string | null {
  if (BROWSER_CDP_DENIED_METHODS.has(method)) {
    return `Error: CDP method is not allowed: ${method}`;
  }
  if (
    !BROWSER_CDP_ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix))
  ) {
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

function readMaxChars(args: BrowserExtractToolInput): number | string {
  const raw = args.max_chars ?? DEFAULT_FETCH_PREVIEW_CHARS;
  const maxChars = Math.min(
    MAX_FETCH_PREVIEW_CHARS,
    Math.max(1, Math.floor(Number(raw))),
  );
  if (!Number.isFinite(maxChars)) {
    return "Error: max_chars must be a number.";
  }
  return maxChars;
}
