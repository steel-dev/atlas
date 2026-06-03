import type { ResearchCtx } from "./runtime.js";
import {
  findSourceDocumentById,
  formatSourceChunk,
  quoteSource,
  searchSourceDocuments,
} from "./source-documents.js";

export interface ReadSourceToolInput {
  source_id?: string;
  chunk_index?: number;
  start?: number;
  end?: number;
}

export interface SearchSourcesToolInput {
  query?: string;
  source_ids?: string[];
  max_results?: number;
}

function sourceId(args: { source_id?: string }): string | null {
  const id = String(args.source_id ?? "").trim();
  return id || null;
}

type SourceIdRead =
  | { ok: true; sourceId: string }
  | { ok: false; error: string };

function readSourceId(
  args: { source_id?: string },
  toolName: string,
): SourceIdRead {
  const id = sourceId(args);
  return id
    ? { ok: true, sourceId: id }
    : { ok: false, error: `Error: ${toolName} requires \`source_id\`.` };
}

function readNonNegativeInteger(raw: unknown, name: string): number | string {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) {
    return `Error: ${name} must be a non-negative integer.`;
  }
  return n;
}

function readPositiveInteger(
  raw: unknown,
  name: string,
  fallback: number,
  max: number,
): number | string {
  const n = Math.floor(Number(raw ?? fallback));
  if (!Number.isFinite(n) || n <= 0) {
    return `Error: ${name} must be a positive integer.`;
  }
  return Math.min(n, max);
}

export function execReadSource(
  args: ReadSourceToolInput,
  ctx: ResearchCtx,
): string {
  const sourceId = readSourceId(args, "read_source");
  if (!sourceId.ok) return sourceId.error;

  const document = findSourceDocumentById(ctx, sourceId.sourceId);
  if (!document) return `Error: unknown source_id: ${sourceId.sourceId}`;

  if (args.start !== undefined || args.end !== undefined) {
    const start = readNonNegativeInteger(args.start, "start");
    if (typeof start === "string") return start;
    const end = readNonNegativeInteger(args.end, "end");
    if (typeof end === "string") return end;
    return quoteSource(document, start, end);
  }

  const chunkIndex = readNonNegativeInteger(
    args.chunk_index ?? 0,
    "chunk_index",
  );
  if (typeof chunkIndex === "string") return chunkIndex;
  return formatSourceChunk(document, chunkIndex);
}

export function execSearchSources(
  args: SearchSourcesToolInput,
  ctx: ResearchCtx,
): string {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: search_sources requires a non-empty `query`.";

  const maxResults = readPositiveInteger(
    args.max_results,
    "max_results",
    10,
    30,
  );
  if (typeof maxResults === "string") return maxResults;

  const documents = documentsForSearch(ctx, args.source_ids);
  if (typeof documents === "string") return documents;
  if (documents.length === 0) {
    return "Error: no fetched source documents are available to search.";
  }
  return searchSourceDocuments(documents, query, maxResults);
}

export function documentsForSearch(
  ctx: ResearchCtx,
  sourceIds: string[] | undefined,
) {
  const ids = Array.isArray(sourceIds)
    ? [
        ...new Set(
          sourceIds.map((id) => String(id ?? "").trim()).filter(Boolean),
        ),
      ]
    : [];
  if (ids.length === 0) return [...ctx.store.sourceDocuments.values()];

  const documents = [];
  for (const id of ids) {
    const document = findSourceDocumentById(ctx, id);
    if (!document) return `Error: unknown source_id: ${id}`;
    documents.push(document);
  }
  return documents;
}
