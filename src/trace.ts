import { AsyncLocalStorage } from "node:async_hooks";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { TraceMode } from "./config.js";

export const TRACE_SCHEMA_VERSION = "1.0";

const MAX_FIELD_CHARS = 256 * 1024; // per prompt/message/output field
const MAX_TOTAL_CHARS = 512 * 1024 * 1024; // whole-run verbatim budget

export type SpanKind = "model" | "tool" | "io" | "agent";
export type SpanStatus = "ok" | "error" | "aborted" | "replayed";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Ambient attribution carried through AsyncLocalStorage so the model middleware
 * and tool executes can tag every span with the agent + code site that produced
 * it, without threading parameters through every signature.
 */
export interface TraceFrame {
  agentId?: string;
  logicalAgentId?: string;
  role?: string;
  depth?: number;
  parentSpanId?: string;
  site?: string;
}

export interface Span {
  id: string;
  parentId?: string;
  kind: SpanKind;
  site: string;
  agentId?: string;
  logicalAgentId?: string;
  role?: string;
  t0: number;
  t1: number;
  durationMs: number;
  waitMs: number;
  computeMs?: number;
  retryDelayMs?: number;
  tokens?: TokenCounts;
  costUSD?: number;
  status: SpanStatus;
  attrs?: Record<string, unknown>;
}

/**
 * Verbatim per model-call record. Shaped to satisfy the eval-explorer
 * `query.ts` TranscriptStep consumer (already built): seq/atMs/role/adapter/
 * durationMs/system/messages/toolNames/maxTokens/outputSchema/output/inputTokens.
 */
export interface TraceStep {
  seq: number;
  atMs: number;
  spanId: string;
  role: string;
  adapter: string;
  site: string;
  agentId?: string;
  durationMs: number;
  waitMs: number;
  system: string;
  messages: unknown[];
  toolNames?: string[];
  maxTokens: number;
  outputSchema?: string;
  output: Array<Record<string, unknown>>;
  inputTokens?: number;
  costUSD?: number;
  finishReason?: string;
  replayed?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface DigestAnomaly {
  kind:
    | "high-wait"
    | "slow-step"
    | "retry-storm"
    | "redundant-call"
    | "oversized-prompt"
    | "empty-output"
    | "error-step"
    | "tail-agent";
  spanId?: string;
  site?: string;
  agentId?: string;
  detail: string;
  severityMs?: number;
}

export interface DigestPhase {
  wallMs: number;
  modelComputeMs: number;
  modelWaitMs: number;
  costUSD: number;
  tokens: number;
  spanCount: number;
}

export interface DigestAgent {
  agentId: string;
  logicalAgentId?: string;
  role?: string;
  selfMs: number;
  subtreeMs: number;
  costUSD: number;
  tokens: number;
  spanCount: number;
}

export interface CriticalSpan {
  spanId: string;
  site: string;
  agentId?: string;
  kind: SpanKind;
  durationMs: number;
  waitMs: number;
}

export interface RunDigest {
  runId: string;
  schemaVersion: string;
  wallMs: number;
  modelComputeMs: number;
  modelWaitMs: number;
  ioMs: number;
  costUSD: number;
  freshTokens: number;
  replayedUSD: number;
  criticalPath: CriticalSpan[];
  criticalPathMs: number;
  idleMs: number;
  phaseBreakdown: Record<string, DigestPhase>;
  byAgent: DigestAgent[];
  topByCost: CriticalSpan[];
  topByLatency: CriticalSpan[];
  topByWait: CriticalSpan[];
  waitVsCompute: { computeMs: number; waitMs: number; ratio: number };
  concurrency: {
    peakModelInFlight: number;
    peakIoInFlight: number;
    gateLimitModel: number;
    gateLimitIo: number;
  };
  anomalies: DigestAnomaly[];
  attribution: Record<string, string>;
  degraded?: boolean;
}

export interface RunTrace {
  schemaVersion: string;
  mode: TraceMode;
  spans: Span[];
  steps: TraceStep[];
  digest?: RunDigest;
  degraded: boolean;
}

/** site -> source location, so a hot span maps back to code an agent can change. */
export const SITE_SOURCE: Record<string, string> = {
  gather: "src/agent.ts:runAgent",
  write: "src/agent.ts:runAgent",
  synthesize: "src/spine.ts:synthesizeHolistic",
  seed: "src/checklist.ts:seedLedger",
  search: "src/tools.ts:execSearchTool",
  fetch: "src/tools.ts:fetchSourceDocument",
  run_code: "src/tools.ts:run_code",
};

const als = new AsyncLocalStorage<TraceFrame>();

export function currentFrame(): TraceFrame | undefined {
  return als.getStore();
}

/**
 * Run `fn` under a trace frame merged onto the current one. When tracing is off
 * (recorder undefined) this is a plain `fn()` — no ALS, no allocation, so there
 * is zero overhead on untraced runs.
 */
export function withTraceFrame<T>(
  recorder: TraceRecorder | undefined,
  patch: TraceFrame,
  fn: () => T,
): T {
  if (!recorder) return fn();
  const parent = als.getStore();
  return als.run({ ...parent, ...patch }, fn);
}

function clampText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_FIELD_CHARS) return { text: value, truncated: false };
  return {
    text: value.slice(0, MAX_FIELD_CHARS) + "…[truncated]",
    truncated: true,
  };
}

function safeJson(value: unknown): { text: string; truncated: boolean } {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return { text: '"[unserializable]"', truncated: true };
  }
  return clampText(raw);
}

function systemFromPrompt(prompt: LanguageModelV3Prompt): string {
  const parts: string[] = [];
  for (const message of prompt) {
    if (message.role !== "system") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
  }
  return clampText(parts.join("\n\n")).text;
}

/**
 * Translate AI-SDK content blocks (`reasoning`/`text`/`tool-call`) into the
 * Anthropic-Messages vocabulary (`thinking`/`text`/`tool_call`) the existing
 * `query.ts` renderBlock consumer expects.
 */
export function toAnthropicBlocks(
  content: readonly LanguageModelV3Content[] | undefined,
): Array<Record<string, unknown>> {
  if (!content) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: clampText(part.text).text });
        break;
      case "reasoning":
        blocks.push({
          type: "thinking",
          thinking: clampText(part.text).text,
        });
        break;
      case "tool-call":
        blocks.push({
          type: "tool_call",
          name: part.toolName,
          input: parseToolInput(part.input),
        });
        break;
      case "tool-result":
        blocks.push({ type: "tool_result", toolName: part.toolName });
        break;
      default:
        blocks.push({ type: part.type });
    }
  }
  return blocks;
}

function parseToolInput(input: string): unknown {
  const { text } = clampText(input);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ModelCallRecord {
  callKey: string;
  role: string;
  provider: string;
  modelId: string;
  t0: number;
  t1: number;
  waitMs: number;
  computeMs: number;
  retryDelayMs?: number;
  attempts?: number;
  tokens?: TokenCounts;
  costUSD?: number;
  finishReason?: string;
  status: SpanStatus;
  replayed?: boolean;
  error?: string;
  // Tier-2 verbatim (captured only when mode === "full"):
  params?: LanguageModelV3CallOptions;
  content?: readonly LanguageModelV3Content[];
}

export interface AgentSpanRecord {
  id: string;
  parentId?: string;
  site: string;
  agentId: string;
  logicalAgentId?: string;
  role?: string;
  t0: number;
  t1: number;
  costUSD?: number;
  status: SpanStatus;
  attrs?: Record<string, unknown>;
}

export interface ToolSpanRecord {
  kind: "tool" | "io";
  site: string;
  agentId?: string;
  parentId?: string;
  t0: number;
  t1: number;
  waitMs: number;
  status: SpanStatus;
  attrs?: Record<string, unknown>;
}

export class TraceRecorder {
  readonly mode: Exclude<TraceMode, "off">;
  private readonly nowFn: () => number;
  private readonly startedAt: number;
  private readonly spanList: Span[] = [];
  private readonly stepList: TraceStep[] = [];
  private spanSeq = 0;
  private totalChars = 0;
  private degradedFlag = false;
  private digest: RunDigest | undefined;
  private sink:
    | ((kind: "span" | "step" | "digest", id: string, data: unknown) => void)
    | undefined;

  constructor(opts: {
    mode: Exclude<TraceMode, "off">;
    now: () => number;
    startedAt: number;
  }) {
    this.mode = opts.mode;
    this.nowFn = opts.now;
    this.startedAt = opts.startedAt;
  }

  now(): number {
    return this.nowFn();
  }

  get spans(): readonly Span[] {
    return this.spanList;
  }

  get steps(): readonly TraceStep[] {
    return this.stepList;
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  mintSpanId(): string {
    return `span_${++this.spanSeq}`;
  }

  /** Where trace entries are streamed for plain-run journaling (P7). */
  setSink(
    sink: (kind: "span" | "step" | "digest", id: string, data: unknown) => void,
  ): void {
    this.sink = sink;
  }

  private addSpan(span: Span): void {
    this.spanList.push(span);
    this.sink?.("span", span.id, span);
  }

  recordAgentSpan(rec: AgentSpanRecord): void {
    this.addSpan({
      id: rec.id,
      ...(rec.parentId ? { parentId: rec.parentId } : {}),
      kind: "agent",
      site: rec.site,
      agentId: rec.agentId,
      ...(rec.logicalAgentId ? { logicalAgentId: rec.logicalAgentId } : {}),
      ...(rec.role ? { role: rec.role } : {}),
      t0: rec.t0,
      t1: rec.t1,
      durationMs: Math.max(0, rec.t1 - rec.t0),
      waitMs: 0,
      ...(rec.costUSD !== undefined ? { costUSD: rec.costUSD } : {}),
      status: rec.status,
      ...(rec.attrs ? { attrs: rec.attrs } : {}),
    });
  }

  recordToolSpan(rec: ToolSpanRecord): void {
    const id = this.mintSpanId();
    this.addSpan({
      id,
      ...(rec.parentId ? { parentId: rec.parentId } : {}),
      kind: rec.kind,
      site: rec.site,
      ...(rec.agentId ? { agentId: rec.agentId } : {}),
      t0: rec.t0,
      t1: rec.t1,
      durationMs: Math.max(0, rec.t1 - rec.t0),
      waitMs: rec.waitMs,
      computeMs: Math.max(0, rec.t1 - rec.t0 - rec.waitMs),
      status: rec.status,
      ...(rec.attrs ? { attrs: rec.attrs } : {}),
    });
  }

  recordModelCall(rec: ModelCallRecord, frame: TraceFrame | undefined): void {
    const id = this.mintSpanId();
    const site = frame?.site ?? rec.role ?? "unattributed";
    this.addSpan({
      id,
      ...(frame?.parentSpanId ? { parentId: frame.parentSpanId } : {}),
      kind: "model",
      site,
      ...(frame?.agentId ? { agentId: frame.agentId } : {}),
      ...(frame?.logicalAgentId ? { logicalAgentId: frame.logicalAgentId } : {}),
      role: rec.role,
      t0: rec.t0,
      t1: rec.t1,
      durationMs: Math.max(0, rec.t1 - rec.t0),
      waitMs: rec.waitMs,
      computeMs: rec.computeMs,
      ...(rec.retryDelayMs ? { retryDelayMs: rec.retryDelayMs } : {}),
      ...(rec.tokens ? { tokens: rec.tokens } : {}),
      ...(rec.costUSD !== undefined ? { costUSD: rec.costUSD } : {}),
      status: rec.status,
      attrs: {
        callKey: rec.callKey,
        adapter: `${rec.provider}:${rec.modelId}`,
        ...(rec.finishReason ? { finishReason: rec.finishReason } : {}),
        ...(rec.replayed ? { replayed: true } : {}),
        ...(rec.attempts && rec.attempts > 1 ? { attempts: rec.attempts } : {}),
      },
    });
    if (this.mode === "full" && rec.params) {
      this.recordStep(id, site, rec, frame);
    }
  }

  private recordStep(
    spanId: string,
    site: string,
    rec: ModelCallRecord,
    frame: TraceFrame | undefined,
  ): void {
    const params = rec.params as LanguageModelV3CallOptions;
    let truncated = false;
    if (this.degradedFlag) {
      // Past the verbatim budget: keep the span, drop the heavy I/O.
      return;
    }
    const messagesPacked = safeJson(params.prompt);
    truncated = truncated || messagesPacked.truncated;
    const outputBlocks = rec.error ? [] : toAnthropicBlocks(rec.content);
    const outputPacked = safeJson(outputBlocks);
    truncated = truncated || outputPacked.truncated;
    this.totalChars += messagesPacked.text.length + outputPacked.text.length;
    if (this.totalChars > MAX_TOTAL_CHARS) {
      this.degradedFlag = true;
      return;
    }
    const toolNames = params.tools
      ?.map((t) => ("name" in t ? t.name : undefined))
      .filter((n): n is string => Boolean(n));
    const responseFormat = params.responseFormat;
    const outputSchema =
      responseFormat && responseFormat.type === "json"
        ? safeJson(responseFormat.schema ?? responseFormat.name ?? "json").text
        : undefined;
    const step: TraceStep = {
      seq: this.stepList.length + 1,
      atMs: Math.max(0, rec.t0 - this.startedAt),
      spanId,
      role: rec.role,
      adapter: `${rec.provider}:${rec.modelId}`,
      site,
      ...(frame?.agentId ? { agentId: frame.agentId } : {}),
      durationMs: rec.computeMs,
      waitMs: rec.waitMs,
      system: systemFromPrompt(params.prompt),
      messages: params.prompt as unknown[],
      ...(toolNames && toolNames.length ? { toolNames } : {}),
      maxTokens: params.maxOutputTokens ?? 0,
      ...(outputSchema ? { outputSchema } : {}),
      output: outputBlocks,
      ...(rec.tokens
        ? { inputTokens: rec.tokens.input + rec.tokens.cacheRead + rec.tokens.cacheWrite }
        : {}),
      ...(rec.costUSD !== undefined ? { costUSD: rec.costUSD } : {}),
      ...(rec.finishReason ? { finishReason: rec.finishReason } : {}),
      ...(rec.replayed ? { replayed: true } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(rec.error ? { error: rec.error } : {}),
    };
    this.stepList.push(step);
    this.sink?.("step", spanId, step);
  }

  finalize(digest: RunDigest): void {
    this.digest = { ...digest, ...(this.degradedFlag ? { degraded: true } : {}) };
    this.sink?.("digest", "digest", this.digest);
  }

  snapshot(): RunTrace {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      mode: this.mode,
      spans: this.spanList,
      steps: this.stepList,
      ...(this.digest ? { digest: this.digest } : {}),
      degraded: this.degradedFlag,
    };
  }
}

export function createTraceRecorder(opts: {
  mode: Exclude<TraceMode, "off">;
  now: () => number;
  startedAt: number;
}): TraceRecorder {
  return new TraceRecorder(opts);
}
