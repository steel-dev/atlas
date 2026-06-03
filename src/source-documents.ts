import type { ResearchCtx } from "./runtime.js";
import type {
  SourceChunk,
  SourceDocument,
  SourceDiscoveredLink,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
import type { HtmlPageMetadata } from "./html-extract.js";
import { normalizeUrlForSource } from "./url.js";

const STORED_MARKDOWN_CAP = 500_000;
const SOURCE_CHUNK_CHARS = 12_000;
const DISCOVERY_LINK_LIMIT = 20;
const SOURCE_CARD_PREVIEW_CHARS = 700;
const SOURCE_SEARCH_CONTEXT_CHARS = 180;

function createChunks(markdown: string): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  for (let start = 0; start < markdown.length; start += SOURCE_CHUNK_CHARS) {
    chunks.push({
      index: chunks.length,
      start,
      end: Math.min(markdown.length, start + SOURCE_CHUNK_CHARS),
    });
  }
  if (chunks.length === 0) {
    chunks.push({ index: 0, start: 0, end: 0 });
  }
  return chunks;
}

export function createSourceDocument(
  url: string,
  title: string,
  markdown: string,
  metadata: SourceExtractionMetadata,
  originalChars: number,
  sourceId: string,
  canonicalUrl = normalizeUrlForSource(url),
): SourceDocument {
  return {
    sourceId,
    url,
    canonicalUrl,
    title,
    markdown,
    originalChars,
    storedChars: markdown.length,
    truncated: originalChars > markdown.length,
    metadata,
    chunks: createChunks(markdown),
  };
}

export function findSourceDocumentByUrl(
  ctx: ResearchCtx,
  normalizedUrl: string,
): SourceDocument | undefined {
  return ctx.store.sourceDocuments.get(normalizedUrl);
}

export function findSourceDocumentById(
  ctx: ResearchCtx,
  sourceId: string,
): SourceDocument | undefined {
  const indexed = ctx.store.sourceDocumentsById?.get(sourceId);
  if (indexed) return indexed;
  for (const document of ctx.store.sourceDocuments.values()) {
    if (document.sourceId === sourceId) return document;
  }
  return undefined;
}

function buildExtractionMetadata(opts: {
  method: string;
  markdownChars: number;
  leadNote: string;
  contentType?: string;
  finalUrl?: string;
  notes?: string[];
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
  discoveredLinks?: SourceDiscoveredLink[];
  pageMetadata?: HtmlPageMetadata;
}): SourceExtractionMetadata {
  const page = opts.pageMetadata;
  return {
    markdownChars: opts.markdownChars,
    method: opts.method,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    ...(opts.finalUrl ? { finalUrl: opts.finalUrl } : {}),
    ...(opts.attempts && opts.attempts.length > 0
      ? { attempts: opts.attempts }
      : {}),
    ...(opts.qualityWarnings && opts.qualityWarnings.length > 0
      ? { qualityWarnings: opts.qualityWarnings }
      : {}),
    ...(opts.discoveredLinks && opts.discoveredLinks.length > 0
      ? { discoveredLinks: opts.discoveredLinks }
      : {}),
    ...(page?.canonical ? { canonical: page.canonical } : {}),
    ...(page?.author ? { author: page.author } : {}),
    ...(page?.articleAuthor ? { articleAuthor: page.articleAuthor } : {}),
    ...(page?.publishedTime ? { publishedTime: page.publishedTime } : {}),
    ...(page?.modifiedTime ? { modifiedTime: page.modifiedTime } : {}),
    ...(page?.description ? { description: page.description } : {}),
    ...(page?.language ? { language: page.language } : {}),
    ...(page?.jsonLd !== undefined ? { jsonLd: page.jsonLd } : {}),
    extractionNotes: [opts.leadNote, ...(opts.notes ?? [])],
  };
}

export function extractionMetadataFromBrowser(opts: {
  markdownChars: number;
  finalUrl?: string;
  notes?: string[];
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
  discoveredLinks?: SourceDiscoveredLink[];
  pageMetadata?: HtmlPageMetadata;
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    ...opts,
    method: "browser_cdp",
    leadNote: "Fetched with browser session via Chrome DevTools Protocol.",
  });
}

export function extractionMetadataFromPdf(opts: {
  markdownChars: number;
  contentType?: string;
  finalUrl?: string;
  notes?: string[];
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
  discoveredLinks?: SourceDiscoveredLink[];
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    ...opts,
    method: "pdf_direct",
    leadNote: "Fetched with direct PDF text extraction.",
  });
}

export function extractionMetadataFromText(opts: {
  markdownChars: number;
  method: "json_direct" | "text_direct" | "xml_direct";
  contentType?: string;
  finalUrl?: string;
  notes?: string[];
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    ...opts,
    leadNote: "Fetched with direct text extraction.",
  });
}

export function extractionMetadataFromScrape(opts: {
  markdownChars: number;
  contentType?: string;
  finalUrl?: string;
  notes?: string[];
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
  discoveredLinks?: SourceDiscoveredLink[];
  pageMetadata?: HtmlPageMetadata;
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    ...opts,
    method: "scrape_proxy",
    leadNote:
      "Fetched server-side with Steel scrape through the residential proxy.",
  });
}

export function extractionMetadataFromHtml(opts: {
  markdownChars: number;
  contentType?: string;
  finalUrl?: string;
  notes?: string[];
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
  discoveredLinks?: SourceDiscoveredLink[];
  pageMetadata?: HtmlPageMetadata;
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    ...opts,
    method: "html_direct",
    leadNote: "Fetched with direct HTML text extraction.",
  });
}

export function storeMarkdown(markdown: string): {
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

export function formatSourceCard(
  document: SourceDocument,
  previewChars = SOURCE_CARD_PREVIEW_CHARS,
): string {
  const qualityWarnings = document.metadata.qualityWarnings ?? [];
  const isDiscoveryPage =
    document.metadata.qualityWarnings?.some((warning) =>
      warning.startsWith("search_listing_page"),
    ) ?? false;
  const previewEnd = Math.min(
    document.markdown.length,
    Math.max(0, Math.floor(previewChars)),
  );
  const result = {
    source_id: document.sourceId,
    title: document.title,
    url: document.url,
    canonical_url: document.canonicalUrl,
    ...(qualityWarnings.length > 0
      ? { source_quality: { warnings: qualityWarnings } }
      : {}),
    ...(document.metadata.method
      ? {
          extraction: {
            method: document.metadata.method,
            ...(document.metadata.contentType
              ? { content_type: document.metadata.contentType }
              : {}),
            ...(document.metadata.finalUrl
              ? { final_url: document.metadata.finalUrl }
              : {}),
            ...(document.metadata.attempts &&
            document.metadata.attempts.length > 0
              ? { attempts: document.metadata.attempts }
              : {}),
            ...(qualityWarnings.length > 0
              ? { quality_warnings: qualityWarnings }
              : {}),
            notes: document.metadata.extractionNotes,
          },
        }
      : {}),
    ...(isDiscoveryPage
      ? {
          discovery: {
            source_kind: "discovery_page",
            links: (document.metadata.discoveredLinks ?? []).slice(
              0,
              DISCOVERY_LINK_LIMIT,
            ),
          },
        }
      : {}),
    source_length_chars: document.markdown.length,
    stored_chars: document.storedChars,
    original_chars: document.originalChars,
    truncated: document.truncated,
    chunk_count: document.chunks.length,
    chunk_chars: SOURCE_CHUNK_CHARS,
    ...(previewEnd > 0
      ? { preview: document.markdown.slice(0, previewEnd) }
      : {}),
    raw_access:
      "Stored as a source document. Use search_sources to find relevant passages across stored sources, read_source to read a chunk or quote an exact span, or digest_source for an optional goal-focused map.",
  };
  return JSON.stringify(result, null, 2);
}

function chunkForRange(document: SourceDocument, start: number): SourceChunk {
  const chunk =
    document.chunks.find(
      (candidate) =>
        start >= candidate.start &&
        (start < candidate.end || candidate.end === document.markdown.length),
    ) ?? document.chunks[document.chunks.length - 1];
  if (!chunk) return { index: 0, start, end: start };
  return chunk;
}

export function formatSourceChunk(
  document: SourceDocument,
  chunkIndex: number,
): string {
  const chunk = document.chunks[chunkIndex];
  if (!chunk) {
    return `Error: source ${document.sourceId} has no chunk ${chunkIndex}.`;
  }
  const result = {
    source_id: document.sourceId,
    title: document.title,
    url: document.url,
    canonical_url: document.canonicalUrl,
    chunk: {
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
      previous_chunk: chunk.index > 0 ? chunk.index - 1 : null,
      next_chunk:
        chunk.index + 1 < document.chunks.length ? chunk.index + 1 : null,
    },
    content: document.markdown.slice(chunk.start, chunk.end),
  };
  return JSON.stringify(result, null, 2);
}

export function searchSourceDocuments(
  documents: SourceDocument[],
  query: string,
  maxResults: number,
): string {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return "Error: search_sources requires a non-empty `query`.";
  }

  const results: Array<{
    source_id: string;
    title: string;
    url: string;
    canonical_url: string;
    chunk_index: number;
    start: number;
    end: number;
    score: number;
    snippet: string;
  }> = [];

  for (const document of documents) {
    for (const chunk of document.chunks) {
      const chunkText = document.markdown.slice(chunk.start, chunk.end);
      const chunkLower = chunkText.toLowerCase();
      let score = 0;
      let firstMatch = -1;
      let lastMatch = -1;
      for (const term of terms) {
        const relative = chunkLower.indexOf(term);
        if (relative === -1) continue;
        const absolute = chunk.start + relative;
        const count = countOccurrences(chunkLower, term);
        score += count * Math.max(1, term.length);
        firstMatch =
          firstMatch === -1 ? absolute : Math.min(firstMatch, absolute);
        lastMatch = Math.max(lastMatch, absolute + term.length);
      }
      if (score === 0 || firstMatch === -1 || lastMatch === -1) continue;
      const snippetStart = Math.max(
        0,
        firstMatch - SOURCE_SEARCH_CONTEXT_CHARS,
      );
      const snippetEnd = Math.min(
        document.markdown.length,
        lastMatch + SOURCE_SEARCH_CONTEXT_CHARS,
      );
      results.push({
        source_id: document.sourceId,
        title: document.title,
        url: document.url,
        canonical_url: document.canonicalUrl,
        chunk_index: chunk.index,
        start: snippetStart,
        end: snippetEnd,
        score,
        snippet: document.markdown.slice(snippetStart, snippetEnd),
      });
    }
  }

  results.sort(
    (a, b) => b.score - a.score || a.source_id.localeCompare(b.source_id),
  );
  return JSON.stringify(
    {
      query,
      result_count: Math.min(results.length, maxResults),
      matches: results.slice(0, maxResults),
    },
    null,
    2,
  );
}

function searchTerms(query: string): string[] {
  const quoted = Array.from(query.matchAll(/"([^"]+)"/g))
    .map((match) => match[1]?.trim().toLowerCase())
    .filter((term): term is string => Boolean(term));
  const unquoted = query
    .replace(/"[^"]+"/g, " ")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 2);
  return [...new Set([...quoted, ...unquoted])];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const found = haystack.indexOf(needle, fromIndex);
    if (found === -1) return count;
    count++;
    fromIndex = found + needle.length;
  }
}

export function quoteSource(
  document: SourceDocument,
  start: number,
  end: number,
): string {
  const safeStart = Math.max(0, Math.floor(start));
  const safeEnd = Math.min(document.markdown.length, Math.floor(end));
  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
    return "Error: read_source start/end must be finite numbers.";
  }
  if (safeEnd <= safeStart) {
    return "Error: read_source end must be greater than start.";
  }
  const chunk = chunkForRange(document, safeStart);
  return JSON.stringify(
    {
      source_id: document.sourceId,
      title: document.title,
      url: document.url,
      canonical_url: document.canonicalUrl,
      start: safeStart,
      end: safeEnd,
      chunk_index: chunk.index,
      quote: document.markdown.slice(safeStart, safeEnd),
    },
    null,
    2,
  );
}
