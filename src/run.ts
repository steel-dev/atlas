import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { adjudicateCoverage } from "./adjudicate.js";
import type { AgentResult } from "./agent.js";
import { bindCitations, type Citation } from "./bind.js";
import { withGrant, type BudgetGrant, type BudgetMeter } from "./budget.js";
import {
  resolveRunConfig,
  type AtlasConfig,
  type Budget,
  type ResearchOptions,
  type ResolvedRunConfig,
  type SourceFilter,
} from "./config.js";
import { assembleRun } from "./context.js";
import { conflictPass } from "./conflicts.js";
import { ECONOMY } from "./economy.js";
import { AtlasError, errorMessage, ResumeError } from "./errors.js";
import { EventHub } from "./event-hub.js";
import type { ResearchEvent, RunStats, StopReason } from "./events.js";
import type { ResearchClaim } from "./ledger.js";
import { MODEL_CALL_MAX_RETRIES, totalFreshTokens } from "./model.js";
import { runOrchestrator } from "./orchestrator.js";
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
  capPartitionForReport,
  fallbackReportFromClaims,
  partitionClaims,
  recencyContext,
  repairReport,
  synthesizeReport,
  type ClaimPartition,
} from "./synthesize.js";
import { synthesizeStructured, type FieldBasis } from "./structured.js";
import type { RunCtx } from "./state.js";
import {
  withTraceFrame,
  type RunTrace,
  type TraceRecorder,
} from "./trace.js";
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
  structured?: unknown;
  structuredBasis?: Record<string, FieldBasis>;
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

const IMPORTANCE_RANK: Record<string, number> = {
  central: 0,
  supporting: 1,
  tangential: 2,
};

async function sweepVerification(
  rctx: RunCtx,
  reserve: BudgetGrant,
): Promise<void> {
  if (reserve.floored()) return;
  const pending = rctx.ledger.claims
    .filter((claim) => !claim.duplicateOf && claim.votes.length === 0)
    .sort(
      (a, b) =>
        (IMPORTANCE_RANK[a.importance] ?? 3) -
        (IMPORTANCE_RANK[b.importance] ?? 3),
    )
    .map((claim) => claim.id);
  if (pending.length === 0) return;
  try {
    await rctx.verify({
      claimIds: pending,
      reserve,
      perClaimFraction: ECONOMY.verify.perClaimFraction,
      concurrency: ECONOMY.verify.concurrency,
      cap: ECONOMY.verify.sweepMaxClaims,
    });
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
  }
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
  const { rctx, meter, synthesisGrant, verifyReserve, drainEagerVerifications } =
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

  const orchestrator = await runResearchPhase(
    rctx,
    meter,
    args,
    drainEagerVerifications,
  );

  await consolidateClaims(rctx, meter, verifyReserve, args);
  await rctx.ledger.settle();

  const partition = partitionClaims(
    ledger.claims,
    resolved.envelope.maxReportCandidates,
    recencyContext(rctx),
  );
  const outputs = await composeOutputs(rctx, synthesisGrant, args, {
    partition,
    closingNote: orchestrator.note,
  });
  const { bound, structured, structuredBasis, openQuestions } = outputs;
  emit({ type: "report.completed", report: bound.report });

  const durationMs = args.now() - startedAt;
  const stats = buildStats({
    rctx,
    partition,
    bound: {
      citationsBound: bound.citationsBound,
      citationsUnsupported: bound.citationsUnsupported,
    },
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
    report: bound.report,
    note: orchestrator.note,
    ...(structured !== undefined ? { structured } : {}),
    ...(structuredBasis ? { structuredBasis } : {}),
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
    citations: bound.citations,
    unsupportedSentences: bound.unsupportedSentences,
    stats,
    traceVersion: EVENT_SCHEMA_VERSION,
  };

  emit({ type: "run.completed", stats });
  return result;
}

async function runResearchPhase(
  rctx: RunCtx,
  meter: BudgetMeter,
  args: ExecuteRunArgs,
  drain: () => Promise<void>,
): Promise<AgentResult> {
  const researchGrant = meter.grant({ fraction: 1 }) ?? meter;
  let orchestrator: AgentResult;
  try {
    orchestrator = await runOrchestrator(rctx, researchGrant);
    await rctx.ledger.settle();
    orchestrator = await adjudicatedFollowUps(rctx, researchGrant, orchestrator);
  } catch (err) {
    if (args.hardSignal.aborted || args.isPaused()) throw err;
    rctx.emit({
      type: "run.error",
      message: `lead agent failed: ${errorMessage(err)}`,
      recoverable: true,
    });
    orchestrator = {
      agentId: "agent_1",
      note: `The lead agent terminated early (${errorMessage(err)}). This report is synthesized from the evidence gathered before that point.`,
      claimsAdded: [],
      spentUSD: researchGrant.spentUSD(),
      stopReason: "error",
    };
  } finally {
    if (researchGrant !== meter) researchGrant.release();
  }
  await rctx.ledger.settle();
  await drain();
  args.hardSignal.throwIfAborted();
  if (args.isPaused()) {
    throw new AtlasError("run paused", "paused");
  }
  return orchestrator;
}

async function adjudicatedFollowUps(
  rctx: RunCtx,
  grant: BudgetGrant,
  first: AgentResult,
): Promise<AgentResult> {
  let orchestrator = first;
  const threshold = Math.max(
    ECONOMY.adjudication.minRemainingUSD,
    ECONOMY.adjudication.remainingFraction * rctx.config.budgetUSD,
  );
  const maxRounds = rctx.config.envelope.maxAdjudicationRounds;
  for (let round = 1; round <= maxRounds; round++) {
    if (rctx.stopReason()) break;
    if (grant.remainingUSD() < threshold) break;
    const verdict = await adjudicateCoverage(rctx, grant, orchestrator.note);
    if (!verdict) break;
    rctx.counters.coverageAnswered = verdict.answered;
    rctx.emit({
      type: "coverage.assessed",
      round,
      answered: verdict.answered,
      gaps: verdict.gaps,
    });
    if (verdict.answered || verdict.gaps.length === 0) break;
    try {
      orchestrator = await runOrchestrator(rctx, grant, {
        gaps: verdict.gaps,
        previousNote: orchestrator.note,
      });
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
      rctx.emit({
        type: "run.error",
        message: `coverage follow-up failed: ${errorMessage(err)}`,
        recoverable: true,
      });
      break;
    }
    await rctx.ledger.settle();
  }
  return orchestrator;
}

async function consolidateClaims(
  rctx: RunCtx,
  meter: BudgetMeter,
  verifyReserve: BudgetGrant,
  args: ExecuteRunArgs,
): Promise<void> {
  if (!args.stopSignal.aborted) {
    await withGrant(
      verifyReserve,
      { fraction: ECONOMY.conflicts.fraction, minUSD: ECONOMY.conflicts.minUSD },
      async (grant) => {
        try {
          await conflictPass(rctx, grant);
        } catch (err) {
          if (args.hardSignal.aborted) throw err;
        }
      },
    );
  }
  try {
    if (!args.stopSignal.aborted) {
      await sweepVerification(rctx, verifyReserve);
    }
  } finally {
    if (verifyReserve !== meter) verifyReserve.release();
  }
}

interface ComposeInputs {
  partition: ClaimPartition;
  closingNote: string;
}

interface ComposedOutputs {
  bound: Awaited<ReturnType<typeof bindCitations>>;
  structured: unknown;
  structuredBasis: Record<string, FieldBasis> | undefined;
  openQuestions: string[];
}

async function draftReport(
  rctx: RunCtx,
  grant: BudgetGrant,
  args: ExecuteRunArgs,
  inputs: ComposeInputs,
): Promise<string> {
  const { partition, closingNote } = inputs;
  const fallback = (): string =>
    fallbackReportFromClaims({
      question: rctx.question,
      partition,
      closingNote,
    });
  const empty =
    partition.confirmed.length === 0 &&
    partition.screened.length === 0 &&
    partition.candidates.length === 0 &&
    partition.contested.length === 0;
  if (empty) return fallback();
  try {
    const draft = await withTraceFrame(rctx.recorder, { site: "synthesize" }, () =>
      synthesizeReport(rctx, grant, {
        partition,
        closingNote,
      }),
    );
    if (draft) return draft;
  } catch (err) {
    if (args.hardSignal.aborted) throw err;
    rctx.emit({ type: "report.reset" });
    rctx.emit({
      type: "run.error",
      message: `synthesis failed: ${errorMessage(err)}`,
      recoverable: true,
    });
  }
  return fallback();
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

async function bindAndRepair(
  rctx: RunCtx,
  grant: BudgetGrant,
  args: ExecuteRunArgs,
  draft: string,
): Promise<Awaited<ReturnType<typeof bindCitations>>> {
  let bound = await bindCitations(rctx, grant, draft);
  if (bound.citationsUnsupported > 0 && !grant.floored()) {
    try {
      const repaired = await repairReport(rctx, grant, { draft, bound });
      if (repaired && repaired !== draft) {
        const rebound = await bindCitations(rctx, grant, repaired);
        if (acceptsRepair(bound, rebound)) {
          bound = rebound;
        }
      }
    } catch (err) {
      if (args.hardSignal.aborted) throw err;
      rctx.emit({
        type: "run.error",
        message: `report repair failed: ${errorMessage(err)}`,
        recoverable: true,
      });
    }
  }
  return bound;
}

async function composeOutputs(
  rctx: RunCtx,
  grant: BudgetGrant,
  args: ExecuteRunArgs,
  inputs: ComposeInputs,
): Promise<ComposedOutputs> {
  const { partition, closingNote } = inputs;
  const draft = await draftReport(rctx, grant, args, inputs);

  const bindTask = bindAndRepair(rctx, grant, args, draft);
  const structuredTask = (async () => {
    if (rctx.config.output.kind !== "structured") return undefined;
    try {
      const capped = capPartitionForReport(
        partition,
        rctx.config.envelope.maxReportClaims,
        recencyContext(rctx),
      ).partition;
      return await synthesizeStructured(rctx, grant, {
        schema: rctx.config.output.schema,
        confirmed: [
          ...capped.confirmed,
          ...capped.screened,
          ...capped.contested,
        ],
        candidates: capped.candidates,
      });
    } catch (err) {
      if (args.hardSignal.aborted) throw err;
      throw new AtlasError(
        `structured output failed: ${errorMessage(err)}`,
        "output",
      );
    }
  })();
  const openQuestionsTask = deriveOpenQuestions(
    rctx,
    grant,
    closingNote,
    partition,
  );

  const [bindSettled, structuredSettled, openSettled] =
    await Promise.allSettled([bindTask, structuredTask, openQuestionsTask]);
  if (bindSettled.status === "rejected") throw bindSettled.reason;
  if (structuredSettled.status === "rejected") throw structuredSettled.reason;
  return {
    bound: bindSettled.value,
    structured: structuredSettled.value?.data,
    structuredBasis: structuredSettled.value?.basis,
    openQuestions:
      openSettled.status === "fulfilled" ? openSettled.value : [],
  };
}

const openQuestionsSchema = z.object({
  openQuestions: z.array(z.string()).max(8),
});

async function deriveOpenQuestions(
  rctx: RunCtx,
  grant: BudgetGrant,
  note: string,
  partition: ClaimPartition,
): Promise<string[]> {
  if (!note.trim() && partition.contested.length === 0) return [];
  if (grant.floored()) return [];
  try {
    const result = await withTraceFrame(rctx.recorder, { site: "open-questions" }, () =>
      generateObject({
      model: rctx.bindModel("verify", grant),
      system:
        "You distill the open questions a research run left unanswered. Structured output only.",
      prompt:
        `Research question: ${rctx.question}\n\n` +
        `Lead agent's closing note:\n${note || "(none)"}\n\n` +
        (partition.contested.length > 0
          ? `Contested claims:\n${partition.contested
              .map((claim) => `- ${claim.text}`)
              .join("\n")}\n\n`
          : "") +
        "List up to 5 concrete open questions that remain (empty list if none).",
      schema: openQuestionsSchema,
      maxOutputTokens: 500,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    }),
    );
    return result.object.openQuestions;
  } catch {
    return [];
  }
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
    sourcesFetched: rctx.counters.sourcesFetched,
    sourcesFailed: rctx.counters.sourcesFailed,
    claimsExtracted: rctx.ledger.representatives().length,
    claimsUnsupported: rctx.ledger.unsupportedCount,
    claimsVerified: rctx.counters.claimsVerified,
    claimsConfirmed: partition.confirmed.length,
    claimsScreened: partition.screened.length,
    claimsContested: partition.contested.length,
    claimsRefuted: partition.refuted.length,
    verifyPanelRuns: rctx.counters.verifyPanelRuns,
    verifyPanelDowngradable: rctx.counters.verifyPanelDowngradable,
    verifyPanelCheapMisses: rctx.counters.verifyPanelCheapMisses,
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
  if (meta.outputKind === "structured" && resume.output?.kind !== "structured") {
    throw new ResumeError(
      `run "${runId}" was started with structured output; schemas are not journaled — ` +
        "pass the original schema to resume: atlas.resume(runId, { output: { kind: \"structured\", schema } })",
    );
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
