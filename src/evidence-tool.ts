import type { ResearchLoopContext } from "./runtime.js";
import {
  findInSource,
  findSourceDocumentById,
  formatSourceChunk,
  quoteSource,
} from "./source-documents.js";

export interface ReadSourceChunkToolInput {
  source_id?: string;
  chunk_index?: number;
}

export interface FindInSourceToolInput {
  source_id?: string;
  query?: string;
  max_results?: number;
}

export interface QuoteSourceToolInput {
  source_id?: string;
  start?: number;
  end?: number;
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

function readNonNegativeInteger(
  raw: unknown,
  name: string,
): number | string {
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

export function execReadSourceChunk(
  args: ReadSourceChunkToolInput,
  ctx: ResearchLoopContext,
): string {
  const sourceId = readSourceId(args, "read_source_chunk");
  if (!sourceId.ok) return sourceId.error;

  const chunkIndex = readNonNegativeInteger(args.chunk_index ?? 0, "chunk_index");
  if (typeof chunkIndex === "string") return chunkIndex;

  const document = findSourceDocumentById(ctx, sourceId.sourceId);
  if (!document) return `Error: unknown source_id: ${sourceId.sourceId}`;
  return formatSourceChunk(document, chunkIndex);
}

export function execFindInSource(
  args: FindInSourceToolInput,
  ctx: ResearchLoopContext,
): string {
  const sourceId = readSourceId(args, "find_in_source");
  if (!sourceId.ok) return sourceId.error;

  const query = String(args.query ?? "").trim();
  if (!query) return "Error: find_in_source requires a non-empty `query`.";

  const maxResults = readPositiveInteger(
    args.max_results,
    "max_results",
    5,
    20,
  );
  if (typeof maxResults === "string") return maxResults;

  const document = findSourceDocumentById(ctx, sourceId.sourceId);
  if (!document) return `Error: unknown source_id: ${sourceId.sourceId}`;
  return findInSource(document, query, maxResults);
}

export function execQuoteSource(
  args: QuoteSourceToolInput,
  ctx: ResearchLoopContext,
): string {
  const sourceId = readSourceId(args, "quote_source");
  if (!sourceId.ok) return sourceId.error;

  const start = readNonNegativeInteger(args.start, "start");
  if (typeof start === "string") return start;
  const end = readNonNegativeInteger(args.end, "end");
  if (typeof end === "string") return end;

  const document = findSourceDocumentById(ctx, sourceId.sourceId);
  if (!document) return `Error: unknown source_id: ${sourceId.sourceId}`;
  return quoteSource(document, start, end);
}
