import type { ResearchLoopContext } from "./runtime.js";
import type { SourceDocument, SourceExtractionMetadata } from "./sources.js";

const STORED_MARKDOWN_CAP = 500_000;

export function createSourceDocument(
  url: string,
  title: string,
  markdown: string,
  metadata: SourceExtractionMetadata,
  originalChars = markdown.length,
): SourceDocument {
  return {
    url,
    title,
    markdown,
    originalChars,
    storedChars: markdown.length,
    truncated: originalChars > markdown.length,
    metadata,
  };
}

export function findSourceDocumentByUrl(
  ctx: ResearchLoopContext,
  normalizedUrl: string,
): SourceDocument | undefined {
  return ctx.sourceDocuments.get(normalizedUrl);
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
  const result = {
    title: document.title,
    url: document.url,
    offset: start,
    next_offset: hasMore ? end : null,
    has_more: hasMore,
    content,
  };
  return JSON.stringify(result, null, 2);
}
