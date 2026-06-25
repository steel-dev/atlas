import { randomUUID } from "node:crypto";
import type { FlexibleSchema } from "ai";
import {
  type AtlasConfig,
  type Budget,
  type ResearchOptions,
  type ResolvedRunConfig,
  resolveRunConfig,
  type SourceFilter,
} from "./config.js";
import { assembleRun } from "./context.js";
import { AtlasError, errorMessage } from "./errors.js";
import { EventHub } from "./event-hub.js";
import type {
  Citation,
  ResearchEvent,
  RunStats,
  StopReason,
} from "./events.js";
import { EVENT_SCHEMA_VERSION } from "./events.js";
import { type ModelRole, totalFreshTokens } from "./model.js";
import { runOrchestrated } from "./orchestrate.js";
import { isoDate } from "./prompts.js";
import {
  JournalWriter,
  loadReplayCache,
  loadRunMeta,
  memoryStore,
  type ReplayCache,
  type RunStore,
} from "./providers/store.js";
import { runSpine } from "./spine.js";
import type { RunCtx } from "./state.js";
import { extractStructured } from "./structured.js";
import type { RunTrace, TraceRecorder } from "./trace.js";
import { computeDigest } from "./trace-digest.js";

const EXTRACTION_FRACTION = 0.1;
const EXTRACTION_MIN_USD = 0.02;

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "paused";

export interface SourceRecord {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  via: string;
  chars: number;
  warnings?: string[];
}

export interface ResearchResult {
  runId: string;
  question: string;
  report: string;
  note: string;
  sources: SourceRecord[];
  citations: Citation[];
  unboundCitations: string[];
  warnings: string[];
  stats: RunStats;
  trace?: RunTrace;
  eventVersion: string;
}

export interface ResearchRun {
  readonly id: string;
  events(): AsyncIterable<ResearchEvent>;
  result(): Promise<ResearchResult>;
  abort(): Promise<void>;
  pause(): Promise<void>;
  finish(): Promise<void>;
  status(): RunStatus;
  trace(): RunTrace | undefined;
}

export interface StartRunOptions {
  config: AtlasConfig;
  question: string;
  options: ResearchOptions;
  schema?: FlexibleSchema<unknown> | undefined;
  replay?: ReplayCache | undefined;
  anchorStartedAt?: number | undefined;
  now?: (() => number) | undefined;
}

export function startRun(start: StartRunOptions): ResearchRun {
  const question = start.question?.trim();
  if (!question) {
    throw new AtlasError("research question is required", "config");
  }
  const resolved = resolveRunConfig(start.config, start.options);
  const runId =
    start.options.runId ?? `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const store: RunStore = start.config.store ?? memoryStore();
  const hub = new EventHub();
  const hardController = new AbortController();
  const stopController = new AbortController();
  let statusValue: RunStatus = "running";
  let pauseRequested = false;
  let deadlineHit = false;
  const deadlineTimer =
    resolved.maxDurationMs !== undefined &&
    Number.isFinite(resolved.maxDurationMs) &&
    resolved.maxDurationMs > 0
      ? setTimeout(() => {
          deadlineHit = true;
          hardController.abort();
        }, resolved.maxDurationMs)
      : undefined;
  let recorder: TraceRecorder | undefined;

  const externalSignal = start.options.signal;
  const onExternalAbort = () => hardController.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) hardController.abort(externalSignal.reason);
    else
      externalSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
  }

  const resultPromise = (async (): Promise<ResearchResult> => {
    await Promise.resolve();
    const journal = new JournalWriter(store, runId);
    try {
      const result = await executeRun({
        runId,
        question,
        resolved,
        config: start.config,
        schema: start.schema,
        journal,
        replay: start.replay,
        hub,
        hardSignal: hardController.signal,
        stopSignal: stopController.signal,
        now: start.now ?? Date.now,
        anchorStartedAt: start.anchorStartedAt,
        captureRecorder: (r) => {
          recorder = r;
        },
      });
      statusValue = "completed";
      return result;
    } catch (err) {
      if (pauseRequested) {
        statusValue = "paused";
        journal.event("run.paused", { runId });
        throw new AtlasError(
          "run paused; resume with atlas.resume()",
          "paused",
        );
      }
      if (deadlineHit) {
        statusValue = "failed";
        const event: ResearchEvent = {
          type: "run.error",
          message: "run exceeded maxDurationMs before completing",
          recoverable: false,
        };
        hub.emit(event);
        journal.event(event.type, event);
        throw new AtlasError("run exceeded maxDurationMs", "timeout");
      }
      if (hardController.signal.aborted) {
        statusValue = "aborted";
        throw new AtlasError("run aborted", "aborted");
      }
      statusValue = "failed";
      const event: ResearchEvent = {
        type: "run.error",
        message: errorMessage(err),
        recoverable: false,
      };
      hub.emit(event);
      journal.event(event.type, event);
      throw err;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      await journal.flush();
      hub.close();
    }
  })();
  resultPromise.catch(() => {});

  return {
    id: runId,
    events: () => hub.iterable(),
    result: () => resultPromise,
    status: () => statusValue,
    trace: () => recorder?.snapshot(),
    abort: async () => {
      hardController.abort();
      await resultPromise.catch(() => {});
    },
    pause: async () => {
      pauseRequested = true;
      hardController.abort();
      await resultPromise.catch(() => {});
    },
    finish: async () => {
      stopController.abort();
      await resultPromise.catch(() => {});
    },
  };
}

interface ExecuteRunArgs {
  runId: string;
  question: string;
  resolved: ResolvedRunConfig;
  config: AtlasConfig;
  schema?: FlexibleSchema<unknown> | undefined;
  journal: JournalWriter;
  replay?: ReplayCache | undefined;
  hub: EventHub;
  hardSignal: AbortSignal;
  stopSignal: AbortSignal;
  now: () => number;
  anchorStartedAt?: number | undefined;
  captureRecorder?: ((recorder: TraceRecorder | undefined) => void) | undefined;
}

async function executeRun(args: ExecuteRunArgs): Promise<ResearchResult> {
  const { resolved, question, runId } = args;
  const startedAt = args.now();
  const { rctx, meter, synthesisGrant } = await assembleRun({
    runId,
    question,
    todayISO: isoDate(args.anchorStartedAt ?? startedAt),
    resolved,
    config: args.config,
    journal: args.journal,
    replay: args.replay,
    hub: args.hub,
    hardSignal: args.hardSignal,
    stopSignal: args.stopSignal,
    now: args.now,
    startedAt,
  });
  const { emit } = rctx;
  args.captureRecorder?.(rctx.recorder);

  args.journal.meta({
    runId,
    question,
    effort: resolved.effort,
    budgetUSD: resolved.budgetUSD,
    maxTokens: resolved.maxTokens,
    ...(resolved.maxDurationMs !== undefined
      ? { maxDurationMs: resolved.maxDurationMs }
      : {}),
    maxSources: resolved.maxSources,
    ...(resolved.sourceFilter ? { sourceFilter: resolved.sourceFilter } : {}),
    eventVersion: EVENT_SCHEMA_VERSION,
    startedAt,
  });
  emit({
    type: "run.started",
    runId,
    question,
    effort: resolved.effort,
    budgetUSD: resolved.budgetUSD,
  });
  if (!rctx.runCodeEnabled) {
    emit({
      type: "run_code.unavailable",
      detail:
        'the optional "isolated-vm" sandbox dependency is not installed or failed to build, ' +
        "so the run_code tool is omitted this run; install it to let agents compute over source text. " +
        "Research continues without it.",
    });
  }

  synthesisGrant.release();
  const extractionGrant = args.schema
    ? meter.grant({
        fraction: EXTRACTION_FRACTION,
        minUSD: EXTRACTION_MIN_USD,
      })
    : null;
  const out =
    Object.keys(resolved.researchers).length > 0
      ? await runOrchestrated(rctx, resolved.researchers)
      : await runSpine(rctx, { meter });
  emit({ type: "report.completed", report: out.report });

  let structured: unknown;
  if (args.schema) {
    try {
      structured = await extractStructured(
        rctx.bindModel("write", extractionGrant ?? meter),
        question,
        out.report,
        args.schema,
        args.hardSignal,
      );
    } finally {
      extractionGrant?.release();
    }
  }

  const durationMs = args.now() - startedAt;
  const stats = buildStats({
    rctx,
    bound: {
      citationsBound: out.citations.length,
      citationsUnsupported: out.unboundCitations.length,
    },
    durationMs,
    finished: args.stopSignal.aborted,
  });
  if (rctx.recorder) {
    rctx.recorder.finalize(
      computeDigest(rctx.recorder.spans, rctx.recorder.steps, {
        runId,
        wallMs: durationMs,
        costUSD: stats.costUSD,
        freshTokens: totalFreshTokens(rctx.usage),
        replayedUSD: rctx.usage.replayedUSD,
        gateLimitModel: resolved.maxConcurrentModelCalls,
        gateLimitIo: resolved.maxConcurrentIo,
      }),
    );
  }
  const result: ResearchResult = {
    runId,
    question,
    report: out.report,
    note: out.note,
    sources: out.sources
      ? out.sources.map((source, index) => ({
          id: `source_${index + 1}`,
          url: source.url,
          finalUrl: source.url,
          title: source.title,
          via: source.via,
          chars: source.chars ?? 0,
        }))
      : rctx.sources.fetchedSources.map((source) => {
          const document = source.sourceId
            ? rctx.sources.byId.get(source.sourceId)
            : undefined;
          return {
            id: source.sourceId ?? "",
            url: source.url,
            finalUrl: document?.metadata.finalUrl ?? source.url,
            title: source.title,
            via: document?.metadata.method ?? "unknown",
            chars: document?.storedChars ?? 0,
            ...(document?.metadata.qualityWarnings
              ? { warnings: document.metadata.qualityWarnings }
              : {}),
          };
        }),
    citations: out.citations,
    unboundCitations: out.unboundCitations,
    warnings: out.warnings ?? [],
    stats,
    ...(rctx.recorder ? { trace: rctx.recorder.snapshot() } : {}),
    eventVersion: EVENT_SCHEMA_VERSION,
  };
  if (args.schema) {
    (result as { object?: unknown }).object = structured;
  }

  emit({ type: "run.completed", stats });
  return result;
}

interface RepairBalance {
  citationsUnsupported: number;
  citationsBound: number;
}

export function acceptsRepair(
  before: RepairBalance,
  after: RepairBalance,
): boolean {
  return (
    after.citationsUnsupported < before.citationsUnsupported &&
    after.citationsBound >= before.citationsBound
  );
}

export interface StopReasonInputs {
  finished: boolean;
  budgetExhausted: boolean;
  tokensExhausted: boolean;
  timedOut: boolean;
}

export function deriveStopReason(inputs: StopReasonInputs): StopReason {
  if (inputs.finished) return "finished";
  if (inputs.budgetExhausted) return "budget";
  if (inputs.tokensExhausted) return "tokens";
  if (inputs.timedOut) return "timeout";
  return "completed";
}

function buildStats(opts: {
  rctx: RunCtx;
  bound: { citationsBound: number; citationsUnsupported: number };
  durationMs: number;
  finished: boolean;
}): RunStats {
  const { rctx } = opts;
  const tokens: Partial<Record<ModelRole, { input: number; output: number }>> =
    {};
  for (const [role, roleUsage] of rctx.usage.byRole) {
    tokens[role as ModelRole] = {
      input: roleUsage.input + roleUsage.cacheRead + roleUsage.cacheWrite,
      output: roleUsage.output,
    };
  }
  const budgetExhausted = rctx.meter.exhausted();
  const tokensExhausted = totalFreshTokens(rctx.usage) >= rctx.config.maxTokens;
  const timedOut =
    rctx.deadlineAt !== undefined && rctx.now() >= rctx.deadlineAt;
  return {
    effort: rctx.config.effort,
    searches: rctx.counters.searches,
    searchCacheHits: rctx.counters.searchCacheHits,
    modelCacheHits: rctx.counters.modelCacheHits,
    modelGatePeakWidth: rctx.counters.modelGatePeakWidth,
    sourcesFetched: rctx.counters.sourcesFetched,
    sourcesFailed: rctx.counters.sourcesFailed,
    citationsBound: opts.bound.citationsBound,
    citationsUnsupported: opts.bound.citationsUnsupported,
    tokens,
    costUSD:
      Math.round(
        Math.max(0, rctx.meter.totalSpentUSD() - rctx.usage.replayedUSD) *
          10_000,
      ) / 10_000,
    durationMs: opts.durationMs,
    budgetExhausted,
    tokensExhausted,
    stopReason: deriveStopReason({
      finished: opts.finished,
      budgetExhausted,
      tokensExhausted,
      timedOut,
    }),
  };
}

export type ResumeOptions = Pick<ResearchOptions, "signal">;

function sourceFilterFromMeta(value: unknown): SourceFilter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const filter = value as Record<string, unknown>;
  const domains = (key: "includeDomains" | "excludeDomains") =>
    Array.isArray(filter[key]) &&
    (filter[key] as unknown[]).every((domain) => typeof domain === "string")
      ? { [key]: filter[key] as string[] }
      : {};
  const restored = {
    ...domains("includeDomains"),
    ...domains("excludeDomains"),
  };
  return Object.keys(restored).length > 0 ? restored : undefined;
}

export async function resumeRun(
  runId: string,
  config: AtlasConfig,
  resume: ResumeOptions & { now?: () => number } = {},
): Promise<ResearchRun> {
  const store = config.store;
  if (!store) {
    throw new AtlasError(
      "resume requires config.store (the store the original run journaled to)",
      "resume",
    );
  }
  const meta = await loadRunMeta(store, runId);
  if (!meta || typeof meta.question !== "string") {
    throw new AtlasError(`no journaled run found for "${runId}"`, "resume");
  }
  const replay = await loadReplayCache(store, runId);
  const budget: Budget = {
    ...(typeof meta.budgetUSD === "number" ? { maxUSD: meta.budgetUSD } : {}),
    ...(typeof meta.maxTokens === "number"
      ? { maxTokens: meta.maxTokens }
      : {}),
    ...(typeof meta.maxDurationMs === "number"
      ? { maxDurationMs: meta.maxDurationMs }
      : {}),
    ...(typeof meta.maxSources === "number"
      ? { maxSources: meta.maxSources }
      : {}),
  };
  const sources = sourceFilterFromMeta(meta.sourceFilter);
  const options: ResearchOptions = {
    runId,
    ...(typeof meta.effort === "string"
      ? { effort: meta.effort as ResearchOptions["effort"] }
      : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    ...(sources ? { sources } : {}),
    ...(resume.signal ? { signal: resume.signal } : {}),
  };
  return startRun({
    config,
    question: meta.question,
    options,
    replay,
    anchorStartedAt:
      typeof meta.startedAt === "number" ? meta.startedAt : undefined,
    now: resume.now,
  });
}
