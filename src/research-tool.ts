import { asSchema, type FlexibleSchema, type InferSchema } from "ai";
import type { ModelToolDefinition } from "./model.js";

export type ResearchToolResult = string | { content: string };

export interface ResearchToolContext {
  addSource(source: {
    url: string;
    title: string;
    content?: string;
  }): string | undefined;
  emit(data: unknown): void;
  readonly signal: AbortSignal | undefined;
  readonly budget: {
    msRemaining?: number;
    tokensSpent: number;
    tokenLimit?: number;
  };
}

export interface ResearchToolSpec<SCHEMA extends FlexibleSchema> {
  description: string;
  inputSchema: SCHEMA;
  execute(
    input: InferSchema<SCHEMA>,
    ctx: ResearchToolContext,
  ): ResearchToolResult | Promise<ResearchToolResult>;
}

export interface ResearchTool {
  description: string;
  inputSchema: FlexibleSchema;
  execute(
    input: unknown,
    ctx: ResearchToolContext,
  ): ResearchToolResult | Promise<ResearchToolResult>;
}

export function researchTool<SCHEMA extends FlexibleSchema>(
  spec: ResearchToolSpec<SCHEMA>,
): ResearchTool {
  return spec as unknown as ResearchTool;
}

export interface CompiledUserTool {
  definition: ModelToolDefinition;
  execute(
    input: unknown,
    ctx: ResearchToolContext,
  ): ResearchToolResult | Promise<ResearchToolResult>;
}

export function compileUserTool(
  name: string,
  spec: ResearchTool,
): CompiledUserTool {
  const schema = asSchema(spec.inputSchema);
  return {
    definition: {
      name,
      description: spec.description,
      input_schema: schema.jsonSchema as Record<string, unknown>,
    },
    execute: spec.execute,
  };
}
