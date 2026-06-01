import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ResearchEffort } from "./defaults.js";
import { errorMessage } from "./errors.js";
import { sleep } from "./async.js";
import type { AdaptiveConcurrencyGate, ConcurrencyGate } from "./runtime.js";

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

export interface ModelThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface ModelRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type ModelAssistantBlock =
  | ModelTextBlock
  | ModelToolCall
  | ModelThinkingBlock
  | ModelRedactedThinkingBlock;

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
  inputTokens?: number;
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

export function totalUsageTokens(usage: UsageSummary): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  );
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
  maxRetries?: number;
}): ModelAdapter {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries ?? 2,
  });
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
      const inputTokens =
        (resp.usage.input_tokens ?? 0) +
        (resp.usage.cache_creation_input_tokens ?? 0) +
        (resp.usage.cache_read_input_tokens ?? 0);
      addUsage(usage, {
        input_tokens: resp.usage.input_tokens ?? 0,
        output_tokens: resp.usage.output_tokens ?? 0,
        cache_creation_input_tokens:
          resp.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
      });
      return {
        content: resp.content.flatMap(fromAnthropicBlock),
        inputTokens,
      };
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
      content: message.content.map(
        (result): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: result.tool_call_id,
          content: result.content,
          is_error: result.is_error,
        }),
      ),
    };
  }

  return {
    role: "assistant",
    content: message.content.map(toAnthropicAssistantBlock),
  };
}

function toAnthropicAssistantBlock(
  block: ModelAssistantBlock,
): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_call":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
  }
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
  if (block.type === "thinking") {
    return [
      {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      },
    ];
  }
  if (block.type === "redacted_thinking") {
    return [{ type: "redacted_thinking", data: block.data }];
  }
  return [];
}

export function createOpenAIModelAdapter(opts: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxRetries?: number;
}): ModelAdapter {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
    maxRetries: opts.maxRetries ?? 2,
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
          max_completion_tokens: input.maxTokens,
          ...(input.effort
            ? { reasoning_effort: toOpenAIReasoningEffort(input.effort) }
            : {}),
        },
        { signal: input.signal },
      );
      const inputTokens = resp.usage?.prompt_tokens ?? 0;
      addUsage(usage, {
        input_tokens: inputTokens,
        output_tokens: resp.usage?.completion_tokens ?? 0,
      });
      const message = resp.choices[0]?.message;
      if (!message) return { content: [], inputTokens };
      return { content: fromOpenAIMessage(message), inputTokens };
    },
  };
}

function toOpenAIReasoningEffort(
  effort: ResearchEffort,
): "low" | "medium" | "high" | "xhigh" {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "xhigh";
  }
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

const MODEL_RETRY_MAX_ATTEMPTS = 8;
const MODEL_RETRY_BASE_MS = 1_000;
const MODEL_RETRY_MAX_MS = 30_000;

export interface ModelRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  concurrency: boolean;
}

export interface ModelConcurrencyOptions {
  onRetry?: (info: ModelRetryInfo) => void;
}

export function wrapModelAdapterWithConcurrency(
  adapter: ModelAdapter,
  gate: ConcurrencyGate,
  options: ModelConcurrencyOptions = {},
): ModelAdapter {
  const adaptive = isAdaptiveGate(gate) ? gate : null;
  return {
    provider: adapter.provider,
    model: adapter.model,
    usage: adapter.usage,
    async step(input) {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await gate.run(() => adapter.step(input));
          adaptive?.relax();
          return result;
        } catch (err) {
          if (input.signal?.aborted) throw err;
          const classified = classifyModelError(err);
          if (!classified.retryable || attempt >= MODEL_RETRY_MAX_ATTEMPTS) {
            throw err;
          }
          if (classified.concurrency) adaptive?.throttle();
          const delayMs = retryDelayMs(attempt, classified.retryAfterMs);
          options.onRetry?.({
            attempt,
            maxAttempts: MODEL_RETRY_MAX_ATTEMPTS,
            delayMs,
            concurrency: classified.concurrency,
          });
          await sleep(delayMs, input.signal);
        }
      }
    },
  };
}

function isAdaptiveGate(
  gate: ConcurrencyGate,
): gate is AdaptiveConcurrencyGate {
  return (
    typeof (gate as Partial<AdaptiveConcurrencyGate>).throttle === "function"
  );
}

interface ModelErrorClassification {
  retryable: boolean;
  concurrency: boolean;
  retryAfterMs: number | null;
}

function classifyModelError(err: unknown): ModelErrorClassification {
  const status = (err as { status?: number })?.status;
  const message = errorMessage(err);
  const concurrency = /concurrent connections/i.test(message);
  const rateLimited =
    status === 429 ||
    /\b(rate.?limit|too many requests)\b/i.test(message) ||
    concurrency;
  const overloaded = status === 529 || /\boverloaded\b/i.test(message);
  const transientServer =
    status === 500 || status === 502 || status === 503 || status === 504;
  const connectionError =
    status === undefined &&
    /(connection|econnreset|etimedout|epipe|socket|network|fetch failed|terminated|timeout)/i.test(
      message,
    );
  return {
    retryable: rateLimited || overloaded || transientServer || connectionError,
    concurrency,
    retryAfterMs: readRetryAfterMs(err),
  };
}

function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  const exponential = Math.min(
    MODEL_RETRY_MAX_MS,
    MODEL_RETRY_BASE_MS * 2 ** (attempt - 1),
  );
  const jittered = exponential / 2 + Math.random() * (exponential / 2);
  return Math.max(retryAfterMs ?? 0, Math.round(jittered));
}

function readRetryAfterMs(err: unknown): number | null {
  const raw = readHeaderValue(
    (err as { headers?: unknown })?.headers,
    "retry-after",
  );
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function readHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => string | null }).get(
      name,
    );
    return value ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

export const __testing = {
  toOpenAIMessages,
  fromOpenAIMessage,
  fromAnthropicBlock,
  toAnthropicMessage,
};
