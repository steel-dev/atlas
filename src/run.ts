import { randomUUID } from "node:crypto";
import type { Citation } from "./bind.js";
import {
  resolveRunConfig,
  type AtlasConfig,
  type Budget,
  type ResearchOptions,
  type ResolvedRunConfig,
  type SourceFilter,
} from "./config.js";
import { assembleRun } from "./context.js";
import { AtlasError, errorMessage, ResumeError } from "./errors.js";
import { EventHub } from "./event-hub.js";
import type { ResearchEvent, RunStats, StopReason } from "./events.js";
import type { ResearchClaim } from "./ledger.js";
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
import {
  partitionClaims,
  recencyContext,
  type ClaimPartition,
} from "./synthesize.js";
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

export interface ResearchClaims {
  confirmed: ResearchClaim[];
  screened: ResearchClaim[];
  contested: ResearchClaim[];
  refuted: ResearchClaim[];
  unverified: ResearchClaim[];
}

export interface ResearchResult {
  runId: string;
  question: string;
  report: string;
  note: string;
  claims: ResearchClaims;
  openQuestions: string[];
  sources: SourceRecord[];
  citations: Citation[];
  unsupportedSentences: string[];
  stats: RunStats;
  traceVersion: string;
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
        isPaused: () => pauseRequested,
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
      stopController.abort();
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
  isPaused: () => boolean;
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
  const { ledger, emit } = rctx;
  args.captureRecorder?.(rctx.recorder);

  args.journal.meta({
    runId,
    question,
    effort: resolved.effort,
    budgetUSD: resolved.budgetUSD,
    maxTokens: resolved.maxTokens,
    maxAgents: resolved.maxAgents,
    ...(resolved.maxDurationMs !== undefined
      ? { maxDurationMs: resolved.maxDurationMs }
      : {}),
    maxSources: resolved.maxSources,
    outputKind: resolved.output.kind,
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
  if (resolved.modelFallbackRoles.length > 0) {
    emit({
      type: "model.fallback",
      roles: resolved.modelFallbackRoles,
      modelId: resolved.leadModelId,
      detail:
        `no small model could be derived for ${resolved.modelFallbackRoles.join(" and ")}, ` +
        `so they run on the lead model "${resolved.leadModelId}"; ` +
        "set models.extract and models.verify to a cheaper model to control cost",
    });
  }
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
  let openQuestions: string[];
  let partition: ClaimPartition;
  let citationsBound: number;
  let citationsUnsupported: number;

  synthesisGrant.release();
  const spine = await runSpine(rctx, { meter });
  partition = partitionClaims(
    ledger.claims,
    resolved.envelope.maxReportCandidates,
    recencyContext(rctx),
  );
  report = spine.report;
  note = spine.note;
  citations = spine.citations;
  unsupportedSentences = spine.unsupportedSentences;
  openQuestions = [];
  citationsBound = spine.citations.length;
  citationsUnsupported = spine.unsupportedSentences.length;
  emit({ type: "report.completed", report });

  const durationMs = args.now() - startedAt;
  const stats = buildStats({
    rctx,
    partition,
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
    claims: {
      confirmed: partition.confirmed,
      screened: partition.screened,
      contested: partition.contested,
      refuted: partition.refuted,
      unverified: ledger
        .representatives()
        .filter((claim) => claim.status === "unverified"),
    },
    openQuestions,
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
    stats,
    traceVersion: EVENT_SCHEMA_VERSION,
  };

  emit({ type: "run.completed", stats });
  return result;
}

interface RepairBalance {
  citationsUnsupported: number;
  citationsBound: number;
}

export function draftHasCitationMarkers(draft: string): boolean {
  return /\{\{\s*claim_\w+/.test(draft);
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
  agentCapReached: boolean;
  answered: boolean;
}

export function deriveStopReason(inputs: StopReasonInputs): StopReason {
  if (inputs.stopped) return "stopped";
  if (inputs.budgetExhausted) return "budget";
  if (inputs.tokensExhausted) return "tokens";
  if (inputs.timedOut) return "timeout";
  if (inputs.agentCapReached) return "agent-cap";
  if (inputs.answered) return "answered";
  return "completed";
}

function buildStats(opts: {
  rctx: RunCtx;
  partition: ClaimPartition;
  bound: { citationsBound: number; citationsUnsupported: number };
  durationMs: number;
  stopped: boolean;
}): RunStats {
  const { rctx, partition } = opts;
  const tokens: Record<string, { input: number; output: number }> = {};
  for (const [role, roleUsage] of rctx.usage.byRole) {
    tokens[role] = {
      input: roleUsage.input + roleUsage.cacheRead + roleUsage.cacheWrite,
      output: roleUsage.output,
    };
  }
  const budgetExhausted = rctx.meter.exhausted();
  const tokensExhausted = totalFreshTokens(rctx.usage) >= rctx.config.maxTokens;
  const agentCapReached = rctx.counters.researchSpawnsBlocked > 0;
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
    claimsExtracted: rctx.ledger.representatives().length,
    claimsUnsupported: rctx.ledger.unsupportedCount,
    claimsVerified: rctx.counters.claimsVerified,
    claimsConfirmed: partition.confirmed.length,
    claimsScreened: partition.screened.length,
    claimsContested: partition.contested.length,
    claimsRefuted: partition.refuted.length,
    citationsBound: opts.bound.citationsBound,
    citationsUnsupported: opts.bound.citationsUnsupported,
    dupesDropped: rctx.ledger.dupesDropped,
    agentsSpawned: rctx.counters.agentsSpawned,
    maxDepth: rctx.counters.maxDepth,
    singleAgent: rctx.counters.agentsSpawned === 0,
    tokens,
    costUSD:
      Math.round(
        Math.max(0, rctx.meter.totalSpentUSD() - rctx.usage.replayedUSD) *
          10_000,
      ) / 10_000,
    durationMs: opts.durationMs,
    budgetExhausted,
    tokensExhausted,
    agentCapReached,
    stopReason: deriveStopReason({
      stopped: opts.stopped,
      budgetExhausted,
      tokensExhausted,
      timedOut,
      agentCapReached,
      answered: rctx.counters.coverageAnswered,
    }),
  };
}

export type ResumeOptions = Pick<ResearchOptions, "output" | "signal">;

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
    ...(typeof meta.maxAgents === "number" ? { maxAgents: meta.maxAgents } : {}),
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
    ...(resume.output ? { output: resume.output } : {}),
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
