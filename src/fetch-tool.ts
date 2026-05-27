import type { ResearchLoopContext, ScrapeCacheEntry } from "./runtime.js";
import type { SourceDocument } from "./sources.js";
import {
  createSourceDocument,
  extractionMetadataFromSteel,
  findSourceDocumentByUrl,
  formatFetchResult,
  storeMarkdown,
} from "./source-documents.js";
import { errorMessage } from "./errors.js";
import { runSteelRequest } from "./steel-runtime.js";
import { DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS } from "./tool-contract.js";
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

interface SourceReservation {
  url: string;
}

export const normalizeFetchUrl = normalizeUrlForSource;

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
  return { url: normalizedUrl };
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

async function scrapeWithCache(
  ctx: ResearchLoopContext,
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
): Promise<SourceDocument | null> {
  ctx.emit({ type: "fetching", url });

  const { markdown, title, metadata } = await scrapeWithCache(ctx, url);
  if (!markdown) {
    ctx.caches.scrape.delete(url);
    ctx.emit({
      type: "source_error",
      url,
      error: "Empty markdown",
    });
    return null;
  }

  const resolvedTitle = title ?? url;
  const stored = storeMarkdown(markdown);
  const document = createSourceDocument(
    url,
    resolvedTitle,
    stored.markdown,
    metadata,
    stored.originalChars,
  );
  ctx.fetchedSources.push({
    url,
    title: resolvedTitle,
  });
  ctx.sourceDocuments.set(normalizeFetchUrl(url), document);

  ctx.emit({
    type: "source_fetched",
    url,
    title: resolvedTitle,
  });

  return document;
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
    documentPromise = fetchSourceDocument(ctx, url).finally(() => {
      ctx.sourceReservations.documents.delete(normalizedUrl);
      releaseSourceReservation(ctx, reservation);
    });
    ctx.sourceReservations.documents.set(normalizedUrl, documentPromise);
  }

  try {
    const document = await documentPromise;
    if (!document) {
      return { text: "Empty page (no content fetched)." };
    }

    return {
      fetchedUrl: fetchedThisCall ? document.url : undefined,
      text: formatFetchResult(document, offset, maxChars),
    };
  } catch (err) {
    ctx.caches.scrape.delete(normalizedUrl);
    const message = errorMessage(err);
    ctx.emit({
      type: "source_error",
      url: normalizedUrl,
      error: message,
    });
    return { text: `Fetch error: ${message}` };
  }
}
