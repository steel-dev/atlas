import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  generateObject,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage as AiModelMessage,
  type AssistantContent,
  type ToolContent,
  type ToolSet,
  type LanguageModelUsage,
  type JSONValue,
} from "ai";
import type { ResearchEffort } from "./defaults.js";
import { errorMessage } from "./errors.js";
import { sleep } from "./async.js";
import type { AdaptiveConcurrencyGate, ConcurrencyGate } from "./runtime.js";

export type { LanguageModel } from "ai";

export type ModelProvider = "anthropic" | "openai" | (string & {});

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
  providerMetadata?: Record<string, unknown>;
}

export interface ModelRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
  providerMetadata?: Record<string, unknown>;
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

const EPHEMERAL_CACHE: Record<string, JSONValue> = {
  cacheControl: { type: "ephemeral" },
};

export function createAISdkModelAdapter(opts: {
  model: LanguageModel;
  provider: ModelProvider;
  modelId: string;
}): ModelAdapter {
  const usage = emptyUsageSummary();
  return {
    provider: opts.provider,
    model: opts.modelId,
    usage,
    async step(input) {
      const messages = withCacheBreakpoint(toAiMessages(input.messages));
      const providerOptions = buildProviderOptions(
        input.effort,
        opts.provider,
        opts.modelId,
      );

      if (input.outputSchema) {
        const result = await generateObject({
          model: opts.model,
          system: input.system,
          messages,
          schema: jsonSchema(input.outputSchema.schema),
          maxOutputTokens: input.maxTokens,
          maxRetries: 0,
          abortSignal: input.signal,
          ...(providerOptions ? { providerOptions } : {}),
        });
        addUsage(usage, fromAiUsage(result.usage));
        return {
          content: [{ type: "text", text: JSON.stringify(result.object) }],
          inputTokens: totalInputTokens(result.usage),
        };
      }

      const result = await generateText({
        model: opts.model,
        system: input.system,
        messages,
        ...(input.tools ? { tools: toAiTools(input.tools) } : {}),
        maxOutputTokens: input.maxTokens,
        maxRetries: 0,
        abortSignal: input.signal,
        ...(providerOptions ? { providerOptions } : {}),
      });
      addUsage(usage, fromAiUsage(result.usage));
      return {
        content: fromAiContent(result.content),
        inputTokens: totalInputTokens(result.usage),
      };
    },
  };
}

export function createAnthropicModelAdapter(opts: {
  apiKey: string;
  model: string;
  maxRetries?: number;
}): ModelAdapter {
  const provider = createAnthropic({ apiKey: opts.apiKey });
  return createAISdkModelAdapter({
    model: provider(opts.model),
    provider: "anthropic",
    modelId: opts.model,
  });
}

export function createOpenAIModelAdapter(opts: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxRetries?: number;
}): ModelAdapter {
  const provider = createOpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  });
  return createAISdkModelAdapter({
    model: provider(opts.model),
    provider: "openai",
    modelId: opts.model,
  });
}

function buildProviderOptions(
  effort: ResearchEffort | undefined,
  provider: ModelProvider,
  modelId: string,
): Record<string, Record<string, JSONValue>> | undefined {
  if (!effort) return undefined;
  if (provider === "anthropic") {
    return { anthropic: { thinking: { type: "adaptive" }, effort } };
  }
  if (provider === "openai" && isOpenAiReasoningModel(modelId)) {
    return { openai: { reasoningEffort: effort === "max" ? "xhigh" : effort } };
  }
  return undefined;
}

function isOpenAiReasoningModel(modelId: string): boolean {
  return /^(?:o\d|gpt-5)/i.test(modelId.trim());
}

function toAiTools(tools: ModelToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.input_schema),
    });
  }
  return set;
}

function toAiMessages(messages: ModelMessage[]): AiModelMessage[] {
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool_call") toolNameById.set(block.id, block.name);
    }
  }

  return messages.map((message): AiModelMessage => {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        return { role: "user", content: message.content };
      }
      const content: ToolContent = message.content.map((result) => ({
        type: "tool-result",
        toolCallId: result.tool_call_id,
        toolName: toolNameById.get(result.tool_call_id) ?? "tool",
        output: result.is_error
          ? { type: "error-text", value: result.content }
          : { type: "text", value: result.content },
      }));
      return { role: "tool", content };
    }

    const content: AssistantContent = message.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_call":
          return {
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          };
        case "thinking":
          return {
            type: "reasoning",
            text: block.thinking,
            ...(reasoningProviderOptions(block.providerMetadata, {
              signature: block.signature,
            })
              ? {
                  providerOptions: reasoningProviderOptions(
                    block.providerMetadata,
                    { signature: block.signature },
                  ),
                }
              : {}),
          };
        case "redacted_thinking":
          return {
            type: "reasoning",
            text: "",
            providerOptions: reasoningProviderOptions(block.providerMetadata, {
              redactedData: block.data,
            }) ?? { anthropic: { redactedData: block.data } },
          };
      }
    });
    return { role: "assistant", content };
  });
}

function reasoningProviderOptions(
  providerMetadata: Record<string, unknown> | undefined,
  fallbackAnthropic: Record<string, JSONValue>,
): Record<string, Record<string, JSONValue>> | undefined {
  if (providerMetadata && Object.keys(providerMetadata).length > 0) {
    return providerMetadata as unknown as Record<
      string,
      Record<string, JSONValue>
    >;
  }
  const hasValue = Object.values(fallbackAnthropic).some(
    (v) => v !== undefined && v !== "",
  );
  return hasValue ? { anthropic: fallbackAnthropic } : undefined;
}

function withCacheBreakpoint(messages: AiModelMessage[]): AiModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const withCache = {
    ...last,
    providerOptions: { ...last.providerOptions, anthropic: EPHEMERAL_CACHE },
  } as AiModelMessage;
  return [...messages.slice(0, -1), withCache];
}

type AiContentPart = Awaited<
  ReturnType<typeof generateText>
>["content"][number];

function fromAiContent(content: AiContentPart[]): ModelAssistantBlock[] {
  const blocks: ModelAssistantBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning") {
      const meta = part.providerMetadata as
        | Record<string, Record<string, unknown>>
        | undefined;
      const redactedData = meta?.anthropic?.redactedData;
      if (typeof redactedData === "string") {
        blocks.push({
          type: "redacted_thinking",
          data: redactedData,
          ...(meta ? { providerMetadata: meta } : {}),
        });
      } else {
        const signature = meta?.anthropic?.signature;
        blocks.push({
          type: "thinking",
          thinking: part.text,
          signature: typeof signature === "string" ? signature : "",
          ...(meta ? { providerMetadata: meta } : {}),
        });
      }
    } else if (part.type === "tool-call") {
      blocks.push({
        type: "tool_call",
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      });
    }
  }
  return blocks;
}

function fromAiUsage(u: LanguageModelUsage): Partial<UsageSummary> {
  const cacheRead =
    u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  const noCache =
    u.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
  return {
    input_tokens: noCache,
    output_tokens: u.outputTokens ?? 0,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

function totalInputTokens(u: LanguageModelUsage): number {
  if (typeof u.inputTokens === "number") return u.inputTokens;
  return (
    (u.inputTokenDetails?.noCacheTokens ?? 0) +
    (u.inputTokenDetails?.cacheReadTokens ?? 0) +
    (u.inputTokenDetails?.cacheWriteTokens ?? 0)
  );
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
  const e = err as {
    statusCode?: number;
    status?: number;
    isRetryable?: boolean;
  };
  const status = e?.statusCode ?? e?.status;
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
  const sdkRetryable =
    typeof e?.isRetryable === "boolean" ? e.isRetryable : false;
  return {
    retryable:
      sdkRetryable ||
      rateLimited ||
      overloaded ||
      transientServer ||
      connectionError,
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
  const headers =
    (err as { responseHeaders?: unknown })?.responseHeaders ??
    (err as { headers?: unknown })?.headers;
  const raw = readHeaderValue(headers, "retry-after");
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
  toAiMessages,
  fromAiContent,
  fromAiUsage,
  buildProviderOptions,
  isOpenAiReasoningModel,
};
