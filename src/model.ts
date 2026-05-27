import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ResearchEffort } from "./defaults.js";

export type ModelProvider = "anthropic" | "openai";

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelOutputSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ModelTextBlock {
  type: "text";
  text: string;
}

export interface ModelToolCall {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResult {
  type: "tool_result";
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export type ModelAssistantBlock = ModelTextBlock | ModelToolCall;

export type ModelMessage =
  | { role: "user"; content: string | ModelToolResult[] }
  | { role: "assistant"; content: ModelAssistantBlock[] };

export interface ModelStepInput {
  system: string;
  tools?: ModelToolDefinition[];
  messages: ModelMessage[];
  maxTokens: number;
  effort?: ResearchEffort;
  outputSchema?: ModelOutputSchema;
  signal?: AbortSignal;
}

export interface ModelStepResult {
  content: ModelAssistantBlock[];
}

export interface ModelAdapter {
  provider: ModelProvider;
  model: string;
  usage: UsageSummary;
  step(input: ModelStepInput): Promise<ModelStepResult>;
}

export function emptyUsageSummary(): UsageSummary {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function addUsage(
  target: UsageSummary,
  usage: Partial<UsageSummary> | undefined,
): void {
  if (!usage) return;
  target.input_tokens += usage.input_tokens ?? 0;
  target.output_tokens += usage.output_tokens ?? 0;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  target.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

export function createAnthropicModelAdapter(opts: {
  apiKey: string;
  model: string;
}): ModelAdapter {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 5 });
  const usage = emptyUsageSummary();
  return {
    provider: "anthropic",
    model: opts.model,
    usage,
    async step(input) {
      const resp = await client.messages.create(
        {
          model: opts.model,
          max_tokens: input.maxTokens,
          system: input.system,
          tools: input.tools?.map(toAnthropicTool),
          messages: input.messages.map(toAnthropicMessage),
          cache_control: { type: "ephemeral" },
          ...anthropicRequestConfig(input),
        },
        { signal: input.signal },
      );
      addUsage(usage, {
        input_tokens: resp.usage.input_tokens ?? 0,
        output_tokens: resp.usage.output_tokens ?? 0,
        cache_creation_input_tokens:
          resp.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
      });
      return { content: resp.content.flatMap(fromAnthropicBlock) };
    },
  };
}

function anthropicRequestConfig(input: ModelStepInput): object {
  const outputConfig = {
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.outputSchema
      ? {
          format: {
            type: "json_schema" as const,
            schema: input.outputSchema.schema,
          },
        }
      : {}),
  };
  return {
    ...(input.effort ? { thinking: { type: "adaptive" as const } } : {}),
    ...(Object.keys(outputConfig).length > 0
      ? { output_config: outputConfig }
      : {}),
  };
}

function toAnthropicTool(tool: ModelToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool["input_schema"],
  };
}

function toAnthropicMessage(message: ModelMessage): Anthropic.MessageParam {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return { role: "user", content: message.content };
    }
    return {
      role: "user",
      content: message.content.map((result): Anthropic.ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: result.tool_call_id,
        content: result.content,
        is_error: result.is_error,
      })),
    };
  }

  return {
    role: "assistant",
    content: message.content.map((block) =>
      block.type === "text"
        ? ({ type: "text", text: block.text } satisfies Anthropic.TextBlockParam)
        : ({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          } satisfies Anthropic.ToolUseBlockParam),
    ),
  };
}

function fromAnthropicBlock(
  block: Anthropic.Message["content"][number],
): ModelAssistantBlock[] {
  if (block.type === "text") return [{ type: "text", text: block.text }];
  if (block.type === "tool_use") {
    return [
      {
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input,
      },
    ];
  }
  return [];
}

export function createOpenAIModelAdapter(opts: {
  apiKey: string;
  baseUrl?: string;
  model: string;
}): ModelAdapter {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
    maxRetries: 5,
  });
  const usage = emptyUsageSummary();
  return {
    provider: "openai",
    model: opts.model,
    usage,
    async step(input) {
      const resp = await client.chat.completions.create(
        {
          model: opts.model,
          messages: toOpenAIMessages(input.system, input.messages),
          tools: input.tools?.map(toOpenAITool),
          tool_choice: input.tools?.length ? "auto" : undefined,
          response_format: openAIResponseFormat(input.outputSchema),
          max_tokens: input.maxTokens,
        },
        { signal: input.signal },
      );
      addUsage(usage, {
        input_tokens: resp.usage?.prompt_tokens ?? 0,
        output_tokens: resp.usage?.completion_tokens ?? 0,
      });
      const message = resp.choices[0]?.message;
      if (!message) return { content: [] };
      return { content: fromOpenAIMessage(message) };
    },
  };
}

function openAIResponseFormat(
  outputSchema: ModelOutputSchema | undefined,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming["response_format"] {
  if (!outputSchema) return undefined;
  return {
    type: "json_schema",
    json_schema: {
      name: outputSchema.name,
      schema: outputSchema.schema,
      strict: outputSchema.strict ?? true,
    },
  };
}

function toOpenAITool(
  tool: ModelToolDefinition,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function toOpenAIMessages(
  system: string,
  messages: ModelMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", content: message.content });
      } else {
        for (const result of message.content) {
          out.push({
            role: "tool",
            tool_call_id: result.tool_call_id,
            content: result.content,
          });
        }
      }
      continue;
    }

    const text = message.content
      .filter((block): block is ModelTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = message.content
      .filter((block): block is ModelToolCall => block.type === "tool_call")
      .map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments:
            typeof call.input === "string"
              ? call.input
              : JSON.stringify(call.input ?? {}),
        },
      }));
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return out;
}

function fromOpenAIMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): ModelAssistantBlock[] {
  const blocks: ModelAssistantBlock[] = [];
  if (message.content) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    blocks.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      input: parseOpenAIArguments(call.function.arguments),
    });
  }
  return blocks;
}

function parseOpenAIArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export const __testing = {
  toOpenAIMessages,
  fromOpenAIMessage,
};
