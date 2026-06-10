import { asSchema, type FlexibleSchema } from "ai";

export interface ToolContext {
  addSource(source: { url: string; title?: string; content: string }): void;
  readonly signal?: AbortSignal | undefined;
  log(message: string): void;
}

export interface ResearchTool<I = any> {
  description: string;
  inputSchema: FlexibleSchema<I>;
  execute(input: I, ctx: ToolContext): string | Promise<string>;
}

export interface ResolvedCustomTool {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
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
      name,
      description: tool.description,
      inputJsonSchema: jsonSchemaObject as Record<string, unknown>,
      execute: tool.execute,
    });
  }
  return resolved;
}
