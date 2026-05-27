import type { ResearchLoopContext } from "./runtime.js";
import type {
  SourceChunk,
  SourceDocument,
  SourceExtractionMetadata,
} from "./sources.js";
import { normalizeUrlForSource } from "./url.js";

const STORED_MARKDOWN_CAP = 500_000;
const SOURCE_CHUNK_CHARS = 12_000;

function fallbackSourceId(url: string): string {
  let hash = 5381;
  for (const char of normalizeUrlForSource(url)) {
    hash = (hash * 33) ^ char.charCodeAt(0);
  }
  return `source_${(hash >>> 0).toString(36)}`;
}

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
  originalChars = markdown.length,
  sourceId = fallbackSourceId(url),
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
  ctx: ResearchLoopContext,
  normalizedUrl: string,
): SourceDocument | undefined {
  return ctx.sourceDocuments.get(normalizedUrl);
}

export function findSourceDocumentById(
  ctx: ResearchLoopContext,
  sourceId: string,
): SourceDocument | undefined {
  for (const document of ctx.sourceDocuments.values()) {
    if (document.sourceId === sourceId) return document;
  }
  return undefined;
}

export function extractionMetadataFromSteel(
  markdownChars: number,
): SourceExtractionMetadata {
  return {
    markdownChars,
    extractionNotes: ["Fetched with browser-rendered markdown."],
  };
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

export function formatFetchResult(
  document: SourceDocument,
  offset: number,
  maxChars: number,
): string {
  const start = Math.min(offset, document.markdown.length);
  const end = Math.min(document.markdown.length, start + maxChars);
  const content = document.markdown.slice(start, end);
  const hasMore = end < document.markdown.length;
  const chunk = chunkForRange(document, start);
  const result = {
    source_id: document.sourceId,
    title: document.title,
    url: document.url,
    canonical_url: document.canonicalUrl,
    chunk: {
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
      next_chunk: chunk.index + 1 < document.chunks.length ? chunk.index + 1 : null,
    },
    offset: start,
    next_offset: hasMore ? end : null,
    has_more: hasMore,
    content,
  };
  return JSON.stringify(result, null, 2);
}

function chunkForRange(
  document: SourceDocument,
  start: number,
): SourceChunk {
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
      next_chunk: chunk.index + 1 < document.chunks.length ? chunk.index + 1 : null,
    },
    content: document.markdown.slice(chunk.start, chunk.end),
  };
  return JSON.stringify(result, null, 2);
}

export function findInSource(
  document: SourceDocument,
  query: string,
  maxResults: number,
): string {
  const needle = query.trim().toLowerCase();
  if (!needle) return "Error: find_in_source requires a non-empty `query`.";

  const haystack = document.markdown.toLowerCase();
  const matches: Array<{
    start: number;
    end: number;
    chunk_index: number;
    snippet: string;
  }> = [];
  let fromIndex = 0;
  while (matches.length < maxResults) {
    const start = haystack.indexOf(needle, fromIndex);
    if (start === -1) break;
    const end = start + needle.length;
    const snippetStart = Math.max(0, start - 160);
    const snippetEnd = Math.min(document.markdown.length, end + 160);
    const chunk = chunkForRange(document, start);
    matches.push({
      start,
      end,
      chunk_index: chunk.index,
      snippet: document.markdown.slice(snippetStart, snippetEnd),
    });
    fromIndex = end;
  }

  return JSON.stringify(
    {
      source_id: document.sourceId,
      title: document.title,
      url: document.url,
      canonical_url: document.canonicalUrl,
      query,
      matches,
    },
    null,
    2,
  );
}

export function quoteSource(
  document: SourceDocument,
  start: number,
  end: number,
): string {
  const safeStart = Math.max(0, Math.floor(start));
  const safeEnd = Math.min(document.markdown.length, Math.floor(end));
  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
    return "Error: quote_source start/end must be finite numbers.";
  }
  if (safeEnd <= safeStart) {
    return "Error: quote_source end must be greater than start.";
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
