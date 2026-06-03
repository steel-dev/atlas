import type { ResearchCtx } from "./runtime.js";
import type { ModelAssistantBlock } from "./model.js";
import {
  findSourceDocumentById,
  formatSourceChunk,
  quoteSource,
  searchSourceDocuments,
} from "./source-documents.js";
import {
  DIGEST_SOURCE_SYSTEM_PROMPT,
  digestSourcePrompt,
} from "./tool-contract.js";

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

export interface DigestSourceToolInput {
  source_id?: string;
  goal?: string;
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

export async function execDigestSource(
  args: DigestSourceToolInput,
  ctx: ResearchCtx,
): Promise<string> {
  const sourceId = readSourceId(args, "digest_source");
  if (!sourceId.ok) return sourceId.error;

  const goal = String(args.goal ?? "").trim();
  if (!goal) return "Error: digest_source requires a non-empty `goal`.";

  const document = findSourceDocumentById(ctx, sourceId.sourceId);
  if (!document) return `Error: unknown source_id: ${sourceId.sourceId}`;

  const cacheKey = `digest\u0000${goal}\u0000${document.canonicalUrl}`;
  let digestPromise = ctx.store.caches.summaries.get(cacheKey);
  if (!digestPromise) {
    const model = ctx.deps.summaryModel ?? ctx.deps.model;
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
        signal: ctx.deps.signal,
      })
      .then((resp) => summaryText(resp.content));
    ctx.store.caches.summaries.set(cacheKey, digestPromise);
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
          "Digest is only a navigation aid. Verify any claim with read_source.",
      },
      null,
      2,
    );
  } catch {
    ctx.store.caches.summaries.delete(cacheKey);
    return "Error: digest_source failed.";
  }
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

function summaryText(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}
