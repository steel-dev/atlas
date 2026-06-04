import { asSchema, type FlexibleSchema } from "ai";
import type { ModelToolDefinition } from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import type { SourceDocument } from "./sources.js";
import {
  createSourceDocument,
  extractionMetadataFromCustomTool,
  findSourceDocumentByUrl,
  storeMarkdown,
} from "./source-documents.js";
import { normalizeUrlForSource } from "./url.js";

export interface ToolContext {
  addSource(source: { url: string; title?: string; content: string }): void;
  readonly signal?: AbortSignal;
  log(message: string): void;
}

export interface ResearchTool<I = any> {
  description: string;
  inputSchema: FlexibleSchema<I>;
  execute(input: I, ctx: ToolContext): string | Promise<string>;
}

export interface ResolvedCustomTool {
  definition: ModelToolDefinition;
  execute(input: unknown, ctx: ToolContext): string | Promise<string>;
}

export function researchTool<I>(tool: ResearchTool<I>): ResearchTool<I> {
  return tool;
}

export async function resolveCustomTools(
  tools: Record<string, ResearchTool> | undefined,
): Promise<Map<string, ResolvedCustomTool>> {
  const resolved = new Map<string, ResolvedCustomTool>();
  if (!tools) return resolved;
  for (const [name, tool] of Object.entries(tools)) {
    const jsonSchemaObject = await Promise.resolve(
      asSchema(tool.inputSchema).jsonSchema,
    );
    resolved.set(name, {
      definition: {
        name,
        description: tool.description,
        input_schema: jsonSchemaObject as Record<string, unknown>,
      },
      execute: tool.execute,
    });
  }
  return resolved;
}

export function customToolDefinitions(ctx: ResearchCtx): ModelToolDefinition[] {
  if (!ctx.tools) return [];
  return [...ctx.tools.values()].map((tool) => tool.definition);
}

export function addToolSource(
  ctx: ResearchCtx,
  opts: { url: string; title?: string; content: string; toolName: string },
): SourceDocument | null {
  const url = String(opts.url ?? "").trim();
  const content = String(opts.content ?? "");
  if (!url || !content.trim()) return null;

  const normalizedUrl = normalizeUrlForSource(url);
  const existing = findSourceDocumentByUrl(ctx, normalizedUrl);
  if (existing) return existing;

  const usedSlots =
    ctx.store.fetchedSources.length + ctx.store.sourceReservations.sourceSlots;
  if (usedSlots >= ctx.config.sourceCap) return null;

  const sourceId = `source_${ctx.store.sourceReservations.nextSourceNumber++}`;
  const title = opts.title?.trim() || url;
  const stored = storeMarkdown(content);
  const document = createSourceDocument(
    url,
    title,
    stored.markdown,
    extractionMetadataFromCustomTool({
      markdownChars: stored.markdown.length,
      toolName: opts.toolName,
    }),
    stored.originalChars,
    sourceId,
    normalizedUrl,
  );
  ctx.store.fetchedSources.push({
    url,
    title,
    sourceId: document.sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  ctx.store.sourceDocuments.set(normalizedUrl, document);
  ctx.store.sourceDocumentsById.set(document.sourceId, document);
  ctx.store.claims.queue(ctx, document);
  ctx.scope.emit({
    type: "source_fetched",
    url,
    title,
    method: "custom_tool",
    markdownChars: document.metadata.markdownChars,
  });
  return document;
}

export async function runCustomTool(
  ctx: ResearchCtx,
  tool: ResolvedCustomTool,
  input: unknown,
): Promise<string> {
  const toolName = tool.definition.name;
  let sourcesAdded = 0;
  const toolCtx: ToolContext = {
    addSource: (source) => {
      if (addToolSource(ctx, { ...source, toolName })) sourcesAdded++;
    },
    signal: ctx.deps.signal,
    log: (message) =>
      ctx.scope.emit({
        type: "tool_event",
        tool: toolName,
        data: String(message),
      }),
  };
  const output = await tool.execute(input, toolCtx);
  ctx.scope.emit({
    type: "tool_event",
    tool: toolName,
    data: { sources_added: sourcesAdded },
  });
  return typeof output === "string" ? output : JSON.stringify(output);
}
