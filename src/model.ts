import { createHash } from "node:crypto";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
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
  type BudgetHold,
  type PricingTable,
  type TokenUsage,
} from "./budget.js";
import { ECONOMY } from "./economy.js";
import { errorMessage } from "./errors.js";
import { currentFrame, type SpanStatus, type TraceRecorder } from "./trace.js";
import type { JournalWriter, ReplayCache } from "./providers/store.js";

export type ModelRole = "lead" | "research" | "verify" | "extract" | "write";

export type ResolvedModel = Exclude<LanguageModel, string>;

export interface RunUsage {
  byRole: Map<string, TokenUsage>;
  replayedUSD: number;
}

export function createRunUsage(): RunUsage {
  return { byRole: new Map(), replayedUSD: 0 };
}

function trackUsage(runUsage: RunUsage, role: string, usage: TokenUsage): void {
  const existing = runUsage.byRole.get(role) ?? emptyTokenUsage();
  addTokenUsage(existing, usage);
  runUsage.byRole.set(role, existing);
}

export function totalFreshTokens(usage: RunUsage): number {
  let total = 0;
  for (const roleUsage of usage.byRole.values()) {
    total += roleUsage.input + roleUsage.output + roleUsage.cacheWrite;
  }
  return total;
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
  recorder?: TraceRecorder | undefined;
  onCost?: ((usd: number) => void) | undefined;
  onUnknownModel?: ((modelId: string) => void) | undefined;
  onRateLimit?: ((notice: RateLimitNotice) => void) | undefined;
}

const VOLATILE_BUDGET_PATTERNS: ReadonlyArray<RegExp> = [
  /(budget: )≈\$-?\d[\d,]*(?:\.\d+)?/g,
  /(Remaining research budget: )≈\$-?\d[\d,]*(?:\.\d+)?/g,
];

export function normalizeForCacheKey(serialized: string): string {
  let out = serialized;
  for (const pattern of VOLATILE_BUDGET_PATTERNS) {
    out = out.replace(pattern, (_match, label: string) => `${label}≈$`);
  }
  return out;
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
    .update(normalizeForCacheKey(JSON.stringify(material)))
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

function streamFromJournaledCall(
  record: JournaledCall,
): ReadableStream<LanguageModelV3StreamPart> {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
  ];
  let nextId = 0;
  for (const item of record.content) {
    if (item.type === "text") {
      const id = `replay_${nextId++}`;
      parts.push(
        { type: "text-start", id },
        { type: "text-delta", id, delta: item.text },
        { type: "text-end", id },
      );
    } else if (item.type === "reasoning") {
      const id = `replay_${nextId++}`;
      parts.push(
        { type: "reasoning-start", id },
        { type: "reasoning-delta", id, delta: item.text },
        { type: "reasoning-end", id },
      );
    } else {
      parts.push(item as LanguageModelV3StreamPart);
    }
  }
  parts.push({
    type: "finish",
    usage: record.usage,
    finishReason: record.finishReason,
    ...(record.providerMetadata
      ? { providerMetadata: record.providerMetadata }
      : {}),
  });
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

type JournaledContent = JournaledCall["content"];

interface StreamJournalState {
  content: JournaledContent;
  openText: Map<string, number>;
  openReasoning: Map<string, number>;
  finish?: {
    usage: LanguageModelV3Usage;
    finishReason: JournaledCall["finishReason"];
    providerMetadata?: JournaledCall["providerMetadata"];
  };
}

function collectStreamPart(
  state: StreamJournalState,
  part: LanguageModelV3StreamPart,
): void {
  switch (part.type) {
    case "text-start":
      state.openText.set(
        part.id,
        state.content.push({ type: "text", text: "" }) - 1,
      );
      break;
    case "text-delta": {
      const index = state.openText.get(part.id);
      const entry = index === undefined ? undefined : state.content[index];
      if (entry && entry.type === "text") entry.text += part.delta;
      break;
    }
    case "reasoning-start":
      state.openReasoning.set(
        part.id,
        state.content.push({ type: "reasoning", text: "" }) - 1,
      );
      break;
    case "reasoning-delta": {
      const index = state.openReasoning.get(part.id);
      const entry = index === undefined ? undefined : state.content[index];
      if (entry && entry.type === "reasoning") entry.text += part.delta;
      break;
    }
    case "tool-call":
    case "tool-result":
    case "file":
    case "source":
      state.content.push(part as JournaledContent[number]);
      break;
    case "finish":
      state.finish = {
        usage: part.usage,
        finishReason: part.finishReason,
        ...(part.providerMetadata
          ? { providerMetadata: part.providerMetadata }
          : {}),
      };
      break;
    default:
      break;
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

interface ErrorShape {
  statusCode?: number;
  isRetryable?: boolean;
  responseHeaders?: Record<string, string>;
  message?: string;
  cause?: unknown;
  lastError?: unknown;
  errors?: unknown[];
}

function unwrapErrors(err: unknown): ErrorShape[] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  const out: ErrorShape[] = [];
  while (queue.length > 0 && out.length < 8) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const shape = current as ErrorShape;
    out.push(shape);
    if (shape.cause) queue.push(shape.cause);
    if (shape.lastError) queue.push(shape.lastError);
    if (Array.isArray(shape.errors)) queue.push(...shape.errors.slice(0, 4));
  }
  return out;
}

function classifyRetry(err: unknown): RetryClassification {
  if (isAbortError(err)) return { retryable: false };
  const shapes = unwrapErrors(err);
  const retryAfterMs = shapes
    .map((shape) => parseRetryAfterMs(shape.responseHeaders))
    .find((ms) => ms !== undefined);
  const withDelay = (): RetryClassification =>
    retryAfterMs !== undefined
      ? { retryable: true, retryAfterMs }
      : { retryable: true };
  for (const shape of shapes) {
    if (typeof shape.isRetryable === "boolean") {
      return shape.isRetryable ? withDelay() : { retryable: false };
    }
  }
  const retryableStatus = shapes.some((shape) => {
    const status =
      typeof shape.statusCode === "number" ? shape.statusCode : undefined;
    return (
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500)
    );
  });
  const message = shapes
    .map((shape) => shape.message ?? "")
    .join("\n")
    .toLowerCase();
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
  const recorder = hooks.recorder;

  const settle = (
    usage: LanguageModelV3Usage,
    hold: BudgetHold | null,
  ): number => {
    const tokens = tokenUsageFromV3(usage);
    const { pricing, known } = resolvePricing(inner.modelId, hooks.pricing);
    if (!known) hooks.onUnknownModel?.(inner.modelId);
    const cost = usageCostUSD(tokens, pricing);
    if (hold) hold.settle(cost);
    else hooks.grant.charge(cost);
    trackUsage(hooks.usage, hooks.role, tokens);
    hooks.onCost?.(cost);
    return cost;
  };

  const settleReplay = (usage: LanguageModelV3Usage): number => {
    const tokens = tokenUsageFromV3(usage);
    const { pricing } = resolvePricing(inner.modelId, hooks.pricing);
    const cost = usageCostUSD(tokens, pricing);
    hooks.grant.charge(cost);
    trackUsage(hooks.usage, hooks.role, tokens);
    hooks.usage.replayedUSD += cost;
    hooks.onCost?.(cost);
    return cost;
  };

  const recordReplayStep = (
    key: string,
    params: LanguageModelV3CallOptions,
    cached: JournaledCall,
  ): void => {
    if (!recorder) return;
    const at = recorder.now();
    recorder.recordModelCall(
      {
        callKey: key,
        role: hooks.role,
        provider: inner.provider,
        modelId: inner.modelId,
        t0: at,
        t1: at,
        waitMs: 0,
        computeMs: 0,
        tokens: tokenUsageFromV3(cached.usage),
        finishReason: cached.finishReason.unified,
        status: "replayed",
        replayed: true,
        params,
        content: cached.content,
      },
      currentFrame(),
    );
  };

  const recordCall = (
    key: string,
    params: LanguageModelV3CallOptions,
    timing: { tEnqueue: number; firstWork: number; computeMs: number },
    outcome:
      | {
          status: "ok";
          usage: LanguageModelV3Usage;
          finishReason: string;
          costUSD: number;
          content?: readonly LanguageModelV3Content[];
        }
      | { status: "error" | "aborted"; error: string },
  ): void => {
    if (!recorder) return;
    const tEnd = recorder.now();
    const waitMs = Math.max(0, timing.firstWork - timing.tEnqueue);
    const retryDelayMs = Math.max(
      0,
      tEnd - timing.firstWork - timing.computeMs,
    );
    recorder.recordModelCall(
      {
        callKey: key,
        role: hooks.role,
        provider: inner.provider,
        modelId: inner.modelId,
        t0: timing.tEnqueue,
        t1: tEnd,
        waitMs,
        computeMs: timing.computeMs,
        ...(retryDelayMs ? { retryDelayMs } : {}),
        ...(outcome.status === "ok"
          ? {
              tokens: tokenUsageFromV3(outcome.usage),
              costUSD: outcome.costUSD,
              finishReason: outcome.finishReason,
              status: "ok" as const,
              ...(outcome.content ? { content: outcome.content } : {}),
            }
          : { status: outcome.status, error: outcome.error }),
        params,
      },
      currentFrame(),
    );
  };

  interface CallReservation {
    hold: BudgetHold;
    estimateUSD: number;
  }

  const reserveFor = (
    params: LanguageModelV3CallOptions,
  ): CallReservation | null => {
    const { pricing } = resolvePricing(inner.modelId, hooks.pricing);
    let promptChars = 0;
    try {
      promptChars = JSON.stringify(params.prompt).length;
    } catch {
      promptChars = 0;
    }
    const estimateUSD = usageCostUSD(
      {
        input: promptChars / ECONOMY.callReserve.promptCharsPerToken,
        output:
          params.maxOutputTokens ?? ECONOMY.callReserve.assumedOutputTokens,
        cacheRead: 0,
        cacheWrite: 0,
      },
      pricing,
    );
    const hold = hooks.grant.reserve(estimateUSD);
    return hold ? { hold, estimateUSD } : null;
  };

  const settleFailure = (
    reservation: CallReservation | null,
    err: unknown,
    abortSignal: AbortSignal | undefined,
  ): void => {
    if (!reservation) return;
    if (isAbortError(err) || abortSignal?.aborted) {
      reservation.hold.settle(reservation.estimateUSD);
    } else {
      reservation.hold.release();
    }
  };

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) =>
      isAnthropicModel(inner) ? withCacheBreakpoint(params) : params,
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = callKey(inner, params, hooks.role);
      const cached = hooks.replay?.take(key) as JournaledCall | undefined;
      if (cached) {
        settleReplay(cached.usage);
        recordReplayStep(key, params, cached);
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
      const reservation = reserveFor(params);
      const timing = {
        tEnqueue: recorder ? recorder.now() : 0,
        firstWork: 0,
        computeMs: 0,
      };
      let acquired = false;
      let result: LanguageModelV3GenerateResult;
      try {
        result = await callWithRetry(
          () =>
            hooks.gate.run(() => {
              if (!recorder) return Promise.resolve(doGenerate());
              const s = recorder.now();
              if (!acquired) {
                timing.firstWork = s;
                acquired = true;
              }
              return Promise.resolve(doGenerate()).then(
                (r) => {
                  timing.computeMs += recorder.now() - s;
                  return r;
                },
                (e) => {
                  timing.computeMs += recorder.now() - s;
                  throw e;
                },
              );
            }),
          params.abortSignal,
          hooks.onRateLimit,
        );
      } catch (err) {
        settleFailure(reservation, err, params.abortSignal);
        recordCall(key, params, timing, {
          status:
            isAbortError(err) || params.abortSignal?.aborted
              ? "aborted"
              : "error",
          error: errorMessage(err),
        });
        throw err;
      }
      const costUSD = settle(result.usage, reservation?.hold ?? null);
      if (hooks.journal) {
        const record = serializeResult(result);
        if (record) hooks.journal.call(key, record);
      }
      recordCall(key, params, timing, {
        status: "ok",
        usage: result.usage,
        finishReason: result.finishReason.unified,
        costUSD,
        content: result.content,
      });
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const key = callKey(inner, params, hooks.role);
      const cached = hooks.replay?.take(key) as JournaledCall | undefined;
      if (cached) {
        settleReplay(cached.usage);
        recordReplayStep(key, params, cached);
        return { stream: streamFromJournaledCall(cached) };
      }
      const reservation = reserveFor(params);
      const tEnqueue = recorder ? recorder.now() : 0;
      let firstWork = tEnqueue;
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await callWithRetry(
          () =>
            hooks.gate.run(() => {
              if (recorder) firstWork = recorder.now();
              return Promise.resolve(doStream());
            }),
          params.abortSignal,
          hooks.onRateLimit,
        );
      } catch (err) {
        settleFailure(reservation, err, params.abortSignal);
        if (recorder) {
          recordCall(
            key,
            params,
            {
              tEnqueue,
              firstWork,
              computeMs: Math.max(0, recorder.now() - firstWork),
            },
            {
              status:
                isAbortError(err) || params.abortSignal?.aborted
                  ? "aborted"
                  : "error",
              error: errorMessage(err),
            },
          );
        }
        throw err;
      }
      const state: StreamJournalState = {
        content: [],
        openText: new Map(),
        openReasoning: new Map(),
      };
      let lastCost: number | undefined;
      let recorded = false;
      const recordStream = (status: SpanStatus): void => {
        if (!recorder || recorded) return;
        recorded = true;
        const tEnd = recorder.now();
        recorder.recordModelCall(
          {
            callKey: key,
            role: hooks.role,
            provider: inner.provider,
            modelId: inner.modelId,
            t0: tEnqueue,
            t1: tEnd,
            waitMs: Math.max(0, firstWork - tEnqueue),
            computeMs: Math.max(0, tEnd - firstWork),
            ...(state.finish
              ? { tokens: tokenUsageFromV3(state.finish.usage) }
              : {}),
            ...(lastCost !== undefined ? { costUSD: lastCost } : {}),
            ...(state.finish?.finishReason
              ? { finishReason: state.finish.finishReason.unified }
              : {}),
            status,
            params,
            content: state.content,
          },
          currentFrame(),
        );
      };
      const metered = result.stream.pipeThrough(
        new TransformStream<
          LanguageModelV3StreamPart,
          LanguageModelV3StreamPart
        >({
          transform(part, controller) {
            collectStreamPart(state, part);
            if (part.type === "finish") {
              lastCost = settle(part.usage, reservation?.hold ?? null);
            }
            controller.enqueue(part);
          },
          cancel() {
            if (reservation && !state.finish) {
              reservation.hold.settle(reservation.estimateUSD);
            }
            reservation?.hold.release();
            recordStream("aborted");
          },
          flush() {
            if (reservation && !state.finish) {
              reservation.hold.settle(reservation.estimateUSD);
            }
            reservation?.hold.release();
            if (state.finish && hooks.journal) {
              const record = serializeResult({
                content: state.content,
                finishReason: state.finish.finishReason,
                usage: state.finish.usage,
                ...(state.finish.providerMetadata
                  ? { providerMetadata: state.finish.providerMetadata }
                  : {}),
                warnings: [],
              });
              if (record) hooks.journal.call(key, record);
            }
            recordStream(state.finish ? "ok" : "aborted");
          },
        }),
      );
      return { ...result, stream: metered };
    },
  };

  return wrapLanguageModel({ model: inner, middleware }) as LanguageModelV3;
}

export const MODEL_CALL_MAX_RETRIES = 0;
