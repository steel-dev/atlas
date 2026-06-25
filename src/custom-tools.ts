import { asSchema, type FlexibleSchema } from "ai";
import { ConfigError } from "./errors.js";
import { BUILTIN_TOOL_NAMES, LEDGER_TOOL_NAMES } from "./tools.js";

const RESERVED_TOOL_NAMES = new Set<string>([
  ...BUILTIN_TOOL_NAMES,
  ...LEDGER_TOOL_NAMES,
]);
const TOOL_NAME_PATTERN = /^[A-Za-z][\w-]{0,63}$/;

export interface ToolContext {
  addSource(source: { url: string; title?: string; content: string }): void;
  fetchText(url: string): Promise<string | null>;
  readonly signal?: AbortSignal | undefined;
  log(message: string): void;
}

export interface ResearchTool<I = any> {
  description: string;
  inputSchema: FlexibleSchema<I>;
  timeoutMs?: number;
  execute(input: I, ctx: ToolContext): string | Promise<string>;
}

export interface ResolvedCustomTool {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  timeoutMs?: number | undefined;
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
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new ConfigError(
        `custom tool "${name}" would shadow the builtin ${name} tool; pick another name`,
      );
    }
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `custom tool name "${name}" is invalid: use 1-64 letters, digits, _ or -, starting with a letter`,
      );
    }
    const jsonSchemaObject = await Promise.resolve(
      asSchema(tool.inputSchema).jsonSchema,
    );
    resolved.set(name, {
      name,
      description: tool.description,
      inputJsonSchema: jsonSchemaObject as Record<string, unknown>,
      timeoutMs: tool.timeoutMs,
      execute: tool.execute,
    });
  }
  return resolved;
}
