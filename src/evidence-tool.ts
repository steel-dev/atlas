import type { ResearchLoopContext } from "./runtime.js";
import type { ModelAssistantBlock } from "./model.js";
import {
  findInSource,
  findSourceDocumentById,
  formatSourceChunk,
  quoteSource,
  searchSourceDocuments,
} from "./source-documents.js";
import {
  DIGEST_SOURCE_SYSTEM_PROMPT,
  digestSourcePrompt,
} from "./tool-contract.js";

export interface ReadSourceChunkToolInput {
  source_id?: string;
  chunk_index?: number;
}

export interface FindInSourceToolInput {
  source_id?: string;
  query?: string;
  max_results?: number;
}

export interface SearchSourcesToolInput {
  query?: string;
  source_ids?: string[];
  max_results?: number;
}

export interface DigestSourceToolInput {
  source_id?: string;
  goal?: string;
}

export interface QuoteSourceToolInput {
  source_id?: string;
  start?: number;
  end?: number;
}

const DIGEST_INPUT_CHARS = 30_000;
const DIGEST_MAX_TOKENS = 700;

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

export function execSearchSources(
  args: SearchSourcesToolInput,
  ctx: ResearchLoopContext,
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

export async function execDigestSource(
  args: DigestSourceToolInput,
  ctx: ResearchLoopContext,
): Promise<string> {
  const sourceId = readSourceId(args, "digest_source");
  if (!sourceId.ok) return sourceId.error;

  const goal = String(args.goal ?? "").trim();
  if (!goal) return "Error: digest_source requires a non-empty `goal`.";

  const document = findSourceDocumentById(ctx, sourceId.sourceId);
  if (!document) return `Error: unknown source_id: ${sourceId.sourceId}`;

  const cacheKey = `digest\u0000${goal}\u0000${document.canonicalUrl}`;
  let digestPromise = ctx.caches.summaries.get(cacheKey);
  if (!digestPromise) {
    const model = ctx.summaryModel ?? ctx.model;
    digestPromise = model
      .step({
        system: DIGEST_SOURCE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: digestSourcePrompt({
              goal,
              title: document.title,
              url: document.url,
              content: document.markdown.slice(0, DIGEST_INPUT_CHARS),
            }),
          },
        ],
        maxTokens: DIGEST_MAX_TOKENS,
        signal: ctx.signal,
      })
      .then((resp) => summaryText(resp.content));
    ctx.caches.summaries.set(cacheKey, digestPromise);
  }

  try {
    const digest = await digestPromise;
    return JSON.stringify(
      {
        source_id: document.sourceId,
        title: document.title,
        url: document.url,
        canonical_url: document.canonicalUrl,
        goal,
        digest,
        raw_access:
          "Digest is only a navigation aid. Verify any claim with read_source_chunk or quote_source.",
      },
      null,
      2,
    );
  } catch {
    ctx.caches.summaries.delete(cacheKey);
    return "Error: digest_source failed.";
  }
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

function documentsForSearch(
  ctx: ResearchLoopContext,
  sourceIds: string[] | undefined,
) {
  const ids = Array.isArray(sourceIds)
    ? [...new Set(sourceIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) return [...ctx.sourceDocuments.values()];

  const documents = [];
  for (const id of ids) {
    const document = findSourceDocumentById(ctx, id);
    if (!document) return `Error: unknown source_id: ${id}`;
    documents.push(document);
  }
  return documents;
}

function summaryText(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}
