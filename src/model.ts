import { createHash } from "node:crypto";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { sleep } from "./async.js";
import type { ConcurrencyGate } from "./async.js";
import {
  addTokenUsage,
  emptyTokenUsage,
  resolvePricing,
  usageCostUSD,
  type BudgetGrant,
  type PricingTable,
  type TokenUsage,
} from "./budget.js";
import type { JournalWriter, ReplayCache } from "./providers/store.js";

export type ModelRole = "lead" | "research" | "verify" | "extract" | "write";

export type ResolvedModel = Exclude<LanguageModel, string>;

export interface RunUsage {
  byRole: Map<string, TokenUsage>;
}

export function createRunUsage(): RunUsage {
  return { byRole: new Map() };
}

function trackUsage(runUsage: RunUsage, role: string, usage: TokenUsage): void {
  const existing = runUsage.byRole.get(role) ?? emptyTokenUsage();
  addTokenUsage(existing, usage);
  runUsage.byRole.set(role, existing);
}

export function tokenUsageFromV3(usage: LanguageModelV3Usage): TokenUsage {
  const cacheRead = usage.inputTokens.cacheRead ?? 0;
  const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
  const input =
    usage.inputTokens.noCache ??
    Math.max(0, (usage.inputTokens.total ?? 0) - cacheRead - cacheWrite);
  return {
    input,
    output: usage.outputTokens.total ?? 0,
    cacheRead,
    cacheWrite,
  };
}

export interface RateLimitNotice {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface EngineModelHooks {
  role: ModelRole;
  grant: BudgetGrant;
  pricing: PricingTable;
  gate: ConcurrencyGate;
  usage: RunUsage;
  journal?: JournalWriter | undefined;
  replay?: ReplayCache | undefined;
  onCost?: ((usd: number) => void) | undefined;
  onUnknownModel?: ((modelId: string) => void) | undefined;
  onRateLimit?: ((notice: RateLimitNotice) => void) | undefined;
}

function callKey(
  model: LanguageModelV3,
  params: LanguageModelV3CallOptions,
  role: string,
): string {
  const material = {
    role,
    provider: model.provider,
    modelId: model.modelId,
    prompt: params.prompt,
    tools: params.tools?.map((tool) => ({
      type: tool.type,
      name: "name" in tool ? tool.name : undefined,
      description: "description" in tool ? tool.description : undefined,
      inputSchema: "inputSchema" in tool ? tool.inputSchema : undefined,
    })),
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    maxOutputTokens: params.maxOutputTokens,
  };
  return createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")
    .slice(0, 40);
}

interface JournaledCall {
  content: LanguageModelV3GenerateResult["content"];
  finishReason: LanguageModelV3GenerateResult["finishReason"];
  usage: LanguageModelV3Usage;
  providerMetadata?: LanguageModelV3GenerateResult["providerMetadata"];
}

function serializeResult(
  result: LanguageModelV3GenerateResult,
): JournaledCall | null {
  const record: JournaledCall = {
    content: result.content,
    finishReason: result.finishReason,
    usage: result.usage,
    ...(result.providerMetadata
      ? { providerMetadata: result.providerMetadata }
      : {}),
  };
  try {
    JSON.stringify(record);
    return record;
  } catch {
    return null;
  }
}

function isAnthropicModel(model: LanguageModelV3): boolean {
  return model.provider.toLowerCase().includes("anthropic");
}

function withCacheBreakpoint(
  params: LanguageModelV3CallOptions,
): LanguageModelV3CallOptions {
  if (params.prompt.length === 0) return params;
  const prompt = [...params.prompt];
  const last = prompt[prompt.length - 1];
  prompt[prompt.length - 1] = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      anthropic: {
        ...last.providerOptions?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    },
  } as typeof last;
  return { ...params, prompt };
}

const RETRY_MAX_ATTEMPTS = 6; // 1 initial try + up to 5 retries
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000; // cap so a sustained limit can't hang minutes per attempt

interface RetryClassification {
  retryable: boolean;
  retryAfterMs?: number;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function classifyRetry(err: unknown): RetryClassification {
  if (isAbortError(err)) return { retryable: false };
  const e = err as {
    statusCode?: number;
    isRetryable?: boolean;
    responseHeaders?: Record<string, string>;
    message?: string;
  };
  const retryAfterMs = parseRetryAfterMs(e.responseHeaders);
  const withDelay = (): RetryClassification =>
    retryAfterMs !== undefined
      ? { retryable: true, retryAfterMs }
      : { retryable: true };
  if (typeof e.isRetryable === "boolean") {
    return e.isRetryable ? withDelay() : { retryable: false };
  }
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
  const retryableStatus =
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500);
  const message = (e.message ?? "").toLowerCase();
  const retryableMessage =
    /rate limit|too many requests|overloaded|concurrent connections|timeout|timed out|econnreset|etimedout|eai_again|socket hang up|fetch failed|network error/.test(
      message,
    );
  return retryableStatus || retryableMessage
    ? withDelay()
    : { retryable: false };
}

function backoffDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
): number {
  const exponential = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
  );
  const jittered = exponential / 2 + Math.random() * (exponential / 2);
  return Math.min(RETRY_MAX_DELAY_MS, Math.max(retryAfterMs ?? 0, jittered));
}

async function callWithRetry<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal | undefined,
  onRateLimit: ((notice: RateLimitNotice) => void) | undefined,
): Promise<T> {
  let tries = 0;
  for (;;) {
    tries++;
    try {
      return await attempt();
    } catch (err) {
      const { retryable, retryAfterMs } = classifyRetry(err);
      if (!retryable || tries >= RETRY_MAX_ATTEMPTS || signal?.aborted)
        throw err;
      const delayMs = backoffDelayMs(tries, retryAfterMs);
      onRateLimit?.({ attempt: tries, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
}

export function engineModel(
  model: ResolvedModel,
  hooks: EngineModelHooks,
): LanguageModelV3 {
  const inner = model as LanguageModelV3;
  const settle = (usage: LanguageModelV3Usage): void => {
    const tokens = tokenUsageFromV3(usage);
    const { pricing, known } = resolvePricing(inner.modelId, hooks.pricing);
    if (!known) hooks.onUnknownModel?.(inner.modelId);
    const cost = usageCostUSD(tokens, pricing);
    hooks.grant.charge(cost);
    trackUsage(hooks.usage, hooks.role, tokens);
    hooks.onCost?.(cost);
  };

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) =>
      isAnthropicModel(inner) ? withCacheBreakpoint(params) : params,
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = callKey(inner, params, hooks.role);
      const cached = hooks.replay?.take(key) as JournaledCall | undefined;
      if (cached) {
        return {
          content: cached.content,
          finishReason: cached.finishReason,
          usage: cached.usage,
          ...(cached.providerMetadata
            ? { providerMetadata: cached.providerMetadata }
            : {}),
          warnings: [],
        };
      }
      const result = await callWithRetry(
        () => hooks.gate.run(() => Promise.resolve(doGenerate())),
        params.abortSignal,
        hooks.onRateLimit,
      );
      settle(result.usage);
      if (hooks.journal) {
        const record = serializeResult(result);
        if (record) hooks.journal.call(key, record);
      }
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await callWithRetry(
        () => hooks.gate.run(() => Promise.resolve(doStream())),
        params.abortSignal,
        hooks.onRateLimit,
      );
      const metered = result.stream.pipeThrough(
        new TransformStream<
          LanguageModelV3StreamPart,
          LanguageModelV3StreamPart
        >({
          transform(part, controller) {
            if (part.type === "finish") settle(part.usage);
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream: metered };
    },
  };

  return wrapLanguageModel({ model: inner, middleware }) as LanguageModelV3;
}

export const MODEL_CALL_MAX_RETRIES = 0;
