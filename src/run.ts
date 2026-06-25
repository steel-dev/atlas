import { randomUUID } from "node:crypto";
import {
  resolveRunConfig,
  type AtlasConfig,
  type Budget,
  type ResearchOptions,
  type ResolvedRunConfig,
  type SourceFilter,
} from "./config.js";
import { assembleRun } from "./context.js";
import { AtlasError, ConfigError, errorMessage, ResumeError } from "./errors.js";
import { EventHub } from "./event-hub.js";
import type { Citation, ResearchEvent, RunStats, StopReason } from "./events.js";
import { totalFreshTokens } from "./model.js";
import { isoDate } from "./prompts.js";
import {
  JournalWriter,
  loadReplayCache,
  loadRunMeta,
  memoryStore,
  type ReplayCache,
  type RunStore,
} from "./providers/store.js";
import type { RunCtx } from "./state.js";
import { runSpine } from "./spine.js";
import type { RunTrace, TraceRecorder } from "./trace.js";
import { computeDigest } from "./trace-digest.js";
import { EVENT_SCHEMA_VERSION } from "./events.js";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
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
  unsupportedSentences: string[];
  warnings: string[];
  stats: RunStats;
  trace?: RunTrace;
  eventVersion: string;
}

export interface ResearchRun {
  readonly id: string;
  events(): AsyncIterable<ResearchEvent>;
  result(): Promise<ResearchResult>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  status(): RunStatus;
  trace(): RunTrace | undefined;
}

export interface StartRunOptions {
  config: AtlasConfig;
  question: string;
  options: ResearchOptions;
  replay?: ReplayCache | undefined;
  anchorStartedAt?: number | undefined;
  now?: (() => number) | undefined;
}

export function startRun(start: StartRunOptions): ResearchRun {
  const question = start.question?.trim();
  if (!question) {
    throw new ConfigError("research question is required");
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
        statusValue = "cancelled";
        throw new AtlasError("run cancelled", "cancelled");
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
    cancel: async () => {
      hardController.abort();
      await resultPromise.catch(() => {});
    },
    pause: async () => {
      pauseRequested = true;
      hardController.abort();
      await resultPromise.catch(() => {});
    },
    stop: async () => {
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
  const { rctx, meter, synthesisGrant } =
    await assembleRun({
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

  let report: string;
  let note: string;
  let citations: Citation[];
  let unsupportedSentences: string[];
  let citationsBound: number;
  let citationsUnsupported: number;

  synthesisGrant.release();
  const spine = await runSpine(rctx, { meter });
  report = spine.report;
  note = spine.note;
  citations = spine.citations;
  unsupportedSentences = spine.unsupportedSentences;
  citationsBound = spine.citations.length;
  citationsUnsupported = spine.unsupportedSentences.length;
  emit({ type: "report.completed", report });

  const durationMs = args.now() - startedAt;
  const stats = buildStats({
    rctx,
    bound: { citationsBound, citationsUnsupported },
    durationMs,
    stopped: args.stopSignal.aborted,
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
    report,
    note,
    sources: rctx.sources.fetchedSources.map((source) => {
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
    citations,
    unsupportedSentences,
    warnings: [],
    stats,
    ...(rctx.recorder ? { trace: rctx.recorder.snapshot() } : {}),
    eventVersion: EVENT_SCHEMA_VERSION,
  };

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
  stopped: boolean;
  budgetExhausted: boolean;
  tokensExhausted: boolean;
  timedOut: boolean;
}

export function deriveStopReason(inputs: StopReasonInputs): StopReason {
  if (inputs.stopped) return "stopped";
  if (inputs.budgetExhausted) return "budget";
  if (inputs.tokensExhausted) return "tokens";
  if (inputs.timedOut) return "timeout";
  return "completed";
}

function buildStats(opts: {
  rctx: RunCtx;
  bound: { citationsBound: number; citationsUnsupported: number };
  durationMs: number;
  stopped: boolean;
}): RunStats {
  const { rctx } = opts;
  const tokens: Record<string, { input: number; output: number }> = {};
  for (const [role, roleUsage] of rctx.usage.byRole) {
    tokens[role] = {
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
      stopped: opts.stopped,
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
  const restored = { ...domains("includeDomains"), ...domains("excludeDomains") };
  return Object.keys(restored).length > 0 ? restored : undefined;
}

export async function resumeRun(
  runId: string,
  config: AtlasConfig,
  resume: ResumeOptions & { now?: () => number } = {},
): Promise<ResearchRun> {
  const store = config.store;
  if (!store) {
    throw new ResumeError(
      "resume requires config.store (the store the original run journaled to)",
    );
  }
  const meta = await loadRunMeta(store, runId);
  if (!meta || typeof meta.question !== "string") {
    throw new ResumeError(`no journaled run found for "${runId}"`);
  }
  const replay = await loadReplayCache(store, runId);
  const budget: Budget = {
    ...(typeof meta.budgetUSD === "number" ? { maxUSD: meta.budgetUSD } : {}),
    ...(typeof meta.maxTokens === "number" ? { maxTokens: meta.maxTokens } : {}),
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
