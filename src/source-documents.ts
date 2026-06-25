import type { HtmlPageMetadata } from "./html-extract.js";
import type {
  SourceChunk,
  SourceDiscoveredLink,
  SourceDocument,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
import { normalizeUrlForSource } from "./url.js";

const STORED_MARKDOWN_CAP = 500_000;
const SOURCE_CHUNK_CHARS = 12_000;
const DISCOVERY_LINK_LIMIT = 20;
const SOURCE_CARD_PREVIEW_CHARS = 700;
const GOAL_PASSAGE_MIN_DOC_CHARS = 3_000;
const GOAL_PASSAGE_COUNT = 2;
const GOAL_HEAD_PREVIEW_CHARS = 300;

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

export function extractionMetadataFromCustomTool(opts: {
  markdownChars: number;
  toolName: string;
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    markdownChars: opts.markdownChars,
    method: "custom_tool",
    leadNote: `Added by the "${opts.toolName}" custom tool.`,
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

export function extractionMetadataFromYoutube(opts: {
  markdownChars: number;
  finalUrl?: string;
  attempts?: SourceExtractionAttempt[];
  author?: string;
  language?: string;
  description?: string;
  notes?: string[];
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    markdownChars: opts.markdownChars,
    method: "youtube_transcript",
    leadNote: "Fetched the YouTube caption track (timed text) for this video.",
    ...(opts.finalUrl ? { finalUrl: opts.finalUrl } : {}),
    ...(opts.attempts ? { attempts: opts.attempts } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
    pageMetadata: {
      ...(opts.author ? { author: opts.author } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    } as HtmlPageMetadata,
  });
}

export function extractionMetadataFromExa(opts: {
  markdownChars: number;
  finalUrl?: string;
  attempts?: SourceExtractionAttempt[];
  qualityWarnings?: string[];
}): SourceExtractionMetadata {
  return buildExtractionMetadata({
    ...opts,
    method: "exa_contents",
    leadNote: "Fetched via the Exa /contents API.",
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
  return JSON.stringify(sourceCardData(document, previewChars), null, 2);
}

export function sourceCardData(
  document: SourceDocument,
  previewChars = SOURCE_CARD_PREVIEW_CHARS,
  goal?: string,
): Record<string, unknown> {
  const qualityWarnings = document.metadata.qualityWarnings ?? [];
  const isDiscoveryPage =
    document.metadata.qualityWarnings?.some((warning) =>
      warning.startsWith("search_listing_page"),
    ) ?? false;
  const passages =
    goal?.trim() && document.markdown.length > GOAL_PASSAGE_MIN_DOC_CHARS
      ? rankSourcePassages([document], goal, GOAL_PASSAGE_COUNT)
      : [];
  const headChars =
    passages.length > 0
      ? Math.min(previewChars, GOAL_HEAD_PREVIEW_CHARS)
      : previewChars;
  const previewEnd = Math.min(
    document.markdown.length,
    Math.max(0, Math.floor(headChars)),
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
    ...(passages.length > 0
      ? {
          relevant_passages: passages.map((passage) => ({
            chunk_index: passage.chunkIndex,
            start: passage.start,
            end: passage.end,
            snippet: passage.snippet,
          })),
        }
      : {}),
    raw_access:
      "Stored as a source document. Use search_sources to find relevant passages across stored sources, and read_source to read a chunk or quote an exact span.",
  };
  return result;
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

const SEARCH_WINDOW_CHARS = 900;
const SEARCH_WINDOW_OVERLAP = 200;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface SearchWindow {
  start: number;
  end: number;
  lower: string;
  len: number;
}

const searchWindowCache = new WeakMap<SourceDocument, SearchWindow[]>();

function windowsForDocument(document: SourceDocument): SearchWindow[] {
  const cached = searchWindowCache.get(document);
  if (cached) return cached;
  const text = document.markdown;
  const windows: SearchWindow[] = [];
  const step = SEARCH_WINDOW_CHARS - SEARCH_WINDOW_OVERLAP;
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + SEARCH_WINDOW_CHARS, text.length);
    const slice = text.slice(start, end);
    const len = (slice.match(/[\p{L}\p{N}]+/gu) ?? []).length;
    windows.push({ start, end, lower: slice.toLowerCase(), len });
    if (end >= text.length) break;
  }
  if (windows.length === 0) {
    windows.push({ start: 0, end: 0, lower: "", len: 0 });
  }
  searchWindowCache.set(document, windows);
  return windows;
}

export interface SourcePassage {
  sourceId: string;
  title: string;
  url: string;
  canonicalUrl: string;
  chunkIndex: number;
  start: number;
  end: number;
  score: number;
  snippet: string;
}

export function rankSourcePassages(
  documents: SourceDocument[],
  query: string,
  maxResults: number,
): SourcePassage[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  const pool: Array<{ document: SourceDocument; window: SearchWindow }> = [];
  for (const document of documents) {
    for (const window of windowsForDocument(document)) {
      if (window.lower.length > 0) pool.push({ document, window });
    }
  }
  if (pool.length === 0) return [];

  const total = pool.length;
  const avgdl = pool.reduce((sum, p) => sum + p.window.len, 0) / total || 1;
  const df = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const p of pool) if (p.window.lower.includes(term)) n++;
    df.set(term, n);
  }

  const scored: Array<{
    document: SourceDocument;
    window: SearchWindow;
    score: number;
  }> = [];
  for (const { document, window } of pool) {
    let score = 0;
    const dl = window.len || 1;
    for (const term of terms) {
      const f = countOccurrences(window.lower, term);
      if (f === 0) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      score +=
        (idf * (f * (BM25_K1 + 1))) /
        (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
    }
    if (score > 0) scored.push({ document, window, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.document.sourceId.localeCompare(b.document.sourceId) ||
      a.window.start - b.window.start,
  );

  return scored.slice(0, maxResults).map(({ document, window, score }) => ({
    sourceId: document.sourceId,
    title: document.title,
    url: document.url,
    canonicalUrl: document.canonicalUrl,
    chunkIndex: chunkForRange(document, window.start).index,
    start: window.start,
    end: window.end,
    score: Number(score.toFixed(3)),
    snippet: document.markdown.slice(window.start, window.end).trim(),
  }));
}

export function searchSourceDocuments(
  documents: SourceDocument[],
  query: string,
  maxResults: number,
): string {
  if (searchTerms(query).length === 0) {
    return "Error: search_sources requires a non-empty `query`.";
  }
  const matches = rankSourcePassages(documents, query, maxResults).map(
    (passage) => ({
      source_id: passage.sourceId,
      title: passage.title,
      url: passage.url,
      canonical_url: passage.canonicalUrl,
      chunk_index: passage.chunkIndex,
      start: passage.start,
      end: passage.end,
      score: passage.score,
      snippet: passage.snippet,
    }),
  );
  return JSON.stringify(
    { query, result_count: matches.length, matches },
    null,
    2,
  );
}

const EXTRACTION_GAP_MARKER = "\n\n[…]\n\n";

export function selectExtractionWindow(
  document: SourceDocument,
  query: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (document.markdown.length <= maxChars) {
    return { text: document.markdown, truncated: false };
  }
  const terms = searchTerms(query);
  const scored = document.chunks.map((chunk) => {
    const chunkLower = document.markdown
      .slice(chunk.start, chunk.end)
      .toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += countOccurrences(chunkLower, term) * Math.max(1, term.length);
    }
    return { chunk, score };
  });

  const selected = new Set<number>();
  let used = 0;
  const take = (index: number): void => {
    if (selected.has(index)) return;
    const chunk = document.chunks[index];
    if (!chunk) return;
    const length = chunk.end - chunk.start;
    if (selected.size > 0 && used + length > maxChars) return;
    selected.add(index);
    used += length;
  };

  take(0);
  for (const { chunk, score } of [...scored].sort(
    (a, b) => b.score - a.score,
  )) {
    if (used >= maxChars) break;
    if (score === 0) break;
    take(chunk.index);
  }
  if (selected.size <= 1 && terms.length > 0) {
    for (const chunk of document.chunks) {
      if (used >= maxChars) break;
      take(chunk.index);
    }
  }

  const ordered = [...selected].sort((a, b) => a - b);
  let text = "";
  let previous = -1;
  for (const index of ordered) {
    const chunk = document.chunks[index];
    if (!chunk) continue;
    if (previous !== -1 && index !== previous + 1)
      text += EXTRACTION_GAP_MARKER;
    text += document.markdown.slice(chunk.start, chunk.end);
    previous = index;
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text, truncated: true };
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
