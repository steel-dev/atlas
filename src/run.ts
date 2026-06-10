import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { createConcurrencyGate } from "./async.js";
import { bindCitations, type Citation } from "./bind.js";
import {
  createBudgetMeter,
  DEFAULT_PRICING,
  type BudgetGrant,
  type PricingTable,
} from "./budget.js";
import {
  resolveRunConfig,
  type AtlasConfig,
  type ResearchOptions,
  type ResolvedRunConfig,
} from "./config.js";
import { resolveCustomTools } from "./custom-tools.js";
import { AtlasError, errorMessage } from "./errors.js";
import type { ResearchEvent, RunStats } from "./events.js";
import { createLedger, type ResearchClaim } from "./ledger.js";
import {
  createRunUsage,
  engineModel,
  MODEL_CALL_MAX_RETRIES,
  type ModelRole,
} from "./model.js";
import { runOrchestrator } from "./orchestrator.js";
import { defaultFetchProviders } from "./providers/fetch.js";
import {
  combineSearchProviders,
  defaultSearchProviders,
} from "./providers/search.js";
import {
  JournalWriter,
  loadReplayCache,
  loadRunMeta,
  memoryStore,
  type ReplayCache,
  type RunStore,
} from "./providers/store.js";
import {
  fallbackReportFromClaims,
  partitionClaims,
  synthesizeReport,
  type ClaimPartition,
} from "./synthesize.js";
import { synthesizeStructured, type FieldBasis } from "./structured.js";
import { createRunCounters, createSourceStore, type RunCtx } from "./state.js";
import { runVerifySpawn } from "./verify.js";
import { EVENT_SCHEMA_VERSION } from "./events.js";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export interface Finding {
  id: string;
  statement: string;
  confidence: "high" | "medium" | "low";
  claimIds: string[];
  sourceIds: string[];
}

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
  findings: Finding[];
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
  status(): RunStatus;
}

const SYNTHESIS_FRACTION = 0.15;
const SYNTHESIS_MIN_USD = 0.05;
const TIMEOUT_SYNTHESIS_RESERVE_MS = 120_000;
const BUDGET_WARNING_FRACTIONS = [0.5, 0.8, 0.95];

interface EventSubscriber {
  queue: ResearchEvent[];
  resolveNext: ((result: IteratorResult<ResearchEvent>) => void) | null;
  rejectNext: ((error: unknown) => void) | null;
}

class EventHub {
  private readonly subscribers = new Set<EventSubscriber>();
  private closed = false;
  private failure: unknown = null;

  emit(event: ResearchEvent): void {
    if (this.closed) return;
    for (const sub of this.subscribers) {
      if (sub.resolveNext) {
        const resolve = sub.resolveNext;
        sub.resolveNext = null;
        sub.rejectNext = null;
        resolve({ value: event, done: false });
      } else {
        sub.queue.push(event);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers) {
      sub.resolveNext?.({ value: undefined, done: true });
      sub.resolveNext = null;
      sub.rejectNext = null;
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    for (const sub of this.subscribers) {
      sub.rejectNext?.(error);
      sub.resolveNext = null;
      sub.rejectNext = null;
    }
  }

  iterable(): AsyncIterable<ResearchEvent> {
    const subscribers = this.subscribers;
    const hub = this;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<ResearchEvent> => {
        const sub: EventSubscriber = {
          queue: [],
          resolveNext: null,
          rejectNext: null,
        };
        subscribers.add(sub);
        return {
          next(): Promise<IteratorResult<ResearchEvent>> {
            if (sub.queue.length > 0) {
              return Promise.resolve({
                value: sub.queue.shift() as ResearchEvent,
                done: false,
              });
            }
            if (hub.failure) {
              subscribers.delete(sub);
              return Promise.reject(hub.failure);
            }
            if (hub.closed) {
              subscribers.delete(sub);
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve, reject) => {
              sub.resolveNext = resolve;
              sub.rejectNext = reject;
            });
          },
          return(): Promise<IteratorResult<ResearchEvent>> {
            subscribers.delete(sub);
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

export interface StartRunOptions {
  config: AtlasConfig;
  question: string;
  options: ResearchOptions;
  replay?: ReplayCache | undefined;
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
        now: start.options.now ?? Date.now,
        isPaused: () => pauseRequested,
      });
      statusValue = "completed";
      return result;
    } catch (err) {
      if (pauseRequested) {
        statusValue = "paused";
        journal.event("run.paused", { runId });
        throw new AtlasError(
          "run paused; resume with Atlas.resume()",
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
    cancel: async () => {
      hardController.abort();
      await resultPromise.catch(() => {});
    },
    pause: async () => {
      pauseRequested = true;
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
}

async function executeRun(args: ExecuteRunArgs): Promise<ResearchResult> {
  const { resolved, question, runId } = args;
  const startedAt = args.now();
  const meter = createBudgetMeter(resolved.budgetUSD);
  const usage = createRunUsage();
  const pricing: PricingTable = { ...DEFAULT_PRICING, ...resolved.pricing };
  const modelGate = createConcurrencyGate(resolved.maxConcurrentModelCalls);
  const ioGate = createConcurrencyGate(resolved.maxConcurrentIo);
  const counters = createRunCounters();
  const warnedUnknownModels = new Set<string>();
  const warnedFractions = new Set<number>();
  const deadlineAt = resolved.maxDurationMs
    ? startedAt + resolved.maxDurationMs
    : undefined;

  const budgetExhausted = (): boolean =>
    meter.totalSpentUSD() >= meter.totalUSD - 0.01;

  const emit = (event: ResearchEvent): void => {
    args.hub.emit(event);
    args.journal.event(event.type, event);
  };

  const onCost = (): void => {
    const fraction = meter.totalSpentUSD() / meter.totalUSD;
    for (const threshold of BUDGET_WARNING_FRACTIONS) {
      if (fraction >= threshold && !warnedFractions.has(threshold)) {
        warnedFractions.add(threshold);
        emit({
          type: "budget.warning",
          spentUSD: meter.totalSpentUSD(),
          limitUSD: meter.totalUSD,
          fraction: threshold,
        });
      }
    }
  };

  const searchProviders = Array.isArray(args.config.search)
    ? args.config.search
    : args.config.search
      ? [args.config.search]
      : defaultSearchProviders(resolved.models.lead);
  const fetchChain = Array.isArray(args.config.fetch)
    ? args.config.fetch
    : args.config.fetch
      ? [args.config.fetch]
      : defaultFetchProviders();
  const customTools = await resolveCustomTools(args.config.tools);

  const rctx: RunCtx = {
    runId,
    question,
    config: resolved,
    meter,
    usage,
    pricing,
    ledger: null as never,
    sources: createSourceStore(),
    search: combineSearchProviders(searchProviders),
    fetchChain,
    customTools,
    emit,
    journal: args.journal,
    replay: args.replay,
    signal: args.hardSignal,
    stopSignal: args.stopSignal,
    deadlineAt,
    now: args.now,
    modelGate,
    ioGate,
    seenDomains: new Set(),
    counters,
    agentSequence: { next: 1 },
    bindModel: (role: ModelRole, grant: BudgetGrant) =>
      engineModel(resolved.models[role], {
        role,
        grant,
        pricing,
        gate: modelGate,
        usage,
        journal: args.journal,
        replay: args.replay,
        onCost,
        onUnknownModel: (modelId) => {
          if (warnedUnknownModels.has(modelId)) return;
          warnedUnknownModels.add(modelId);
          emit({
            type: "safety.flag",
            kind: "injection",
            detail: `no pricing entry for model "${modelId}"; charging conservative default rates`,
          });
        },
        onRateLimit: ({ delayMs }) =>
          emit({
            type: "rate.limited",
            retryAfterSeconds: Math.max(1, Math.round(delayMs / 1000)),
          }),
      }),
    rawModel: (role: ModelRole) => resolved.models[role],
    verifySpawn: (spawnArgs) => runVerifySpawn(rctx, spawnArgs),
    stopReason: () => {
      if (args.stopSignal.aborted) return "stop requested";
      if (
        deadlineAt !== undefined &&
        args.now() > deadlineAt - TIMEOUT_SYNTHESIS_RESERVE_MS
      ) {
        return "timeout approaching";
      }
      if (budgetExhausted()) return "budget exhausted";
      return null;
    },
  };
  const ledger = createLedger({
    emit,
    signal: args.hardSignal,
    shouldExtract: () => !budgetExhausted(),
  });
  (rctx as { ledger: typeof ledger }).ledger = ledger;

  args.journal.meta({
    runId,
    question,
    effort: resolved.effort,
    budgetUSD: resolved.budgetUSD,
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

  const synthesisGrant =
    meter.grant({ fraction: SYNTHESIS_FRACTION, minUSD: SYNTHESIS_MIN_USD }) ??
    meter;
  const researchGrant = meter.grant({ fraction: 1 }) ?? meter;

  let orchestrator: Awaited<ReturnType<typeof runOrchestrator>>;
  try {
    orchestrator = await runOrchestrator(rctx, researchGrant);
  } catch (err) {
    if (args.hardSignal.aborted || args.isPaused()) throw err;
    emit({
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
  await ledger.settle();
  args.hardSignal.throwIfAborted();
  if (args.isPaused()) {
    throw new AtlasError("run paused", "paused");
  }

  const partition = partitionClaims(ledger.claims);
  let draft: string;
  if (
    partition.confirmed.length === 0 &&
    partition.candidates.length === 0 &&
    partition.contested.length === 0
  ) {
    draft = fallbackReportFromClaims({
      question,
      partition,
      closingNote: orchestrator.note,
    });
  } else {
    try {
      draft = await synthesizeReport(rctx, synthesisGrant, {
        partition,
        closingNote: orchestrator.note,
      });
      if (!draft) {
        draft = fallbackReportFromClaims({
          question,
          partition,
          closingNote: orchestrator.note,
        });
      }
    } catch (err) {
      if (args.hardSignal.aborted) throw err;
      emit({
        type: "run.error",
        message: `synthesis failed: ${errorMessage(err)}`,
        recoverable: true,
      });
      draft = fallbackReportFromClaims({
        question,
        partition,
        closingNote: orchestrator.note,
      });
    }
  }

  const bound = await bindCitations(rctx, synthesisGrant, draft);

  let structured: unknown;
  let structuredBasis: Record<string, FieldBasis> | undefined;
  if (resolved.output.kind === "structured") {
    try {
      const structuredResult = await synthesizeStructured(
        rctx,
        synthesisGrant,
        {
          schema: resolved.output.schema,
          confirmed: [...partition.confirmed, ...partition.contested],
          candidates: partition.candidates,
        },
      );
      structured = structuredResult.data;
      structuredBasis = structuredResult.basis;
    } catch (err) {
      if (args.hardSignal.aborted) throw err;
      emit({
        type: "run.error",
        message: `structured output failed: ${errorMessage(err)}`,
        recoverable: true,
      });
    }
  }

  const openQuestions = await deriveOpenQuestions(
    rctx,
    synthesisGrant,
    orchestrator.note,
    partition,
  );

  const durationMs = args.now() - startedAt;
  const stats = buildStats({
    rctx,
    partition,
    bound: {
      citationsBound: bound.citationsBound,
      citationsUnsupported: bound.citationsUnsupported,
    },
    durationMs,
  });
  const result: ResearchResult = {
    runId,
    question,
    report: bound.report,
    note: orchestrator.note,
    ...(structured !== undefined ? { structured } : {}),
    ...(structuredBasis ? { structuredBasis } : {}),
    findings: buildFindings(partition),
    claims: {
      confirmed: partition.confirmed,
      contested: partition.contested,
      refuted: partition.refuted,
      unverified: ledger
        .representatives()
        .filter(
          (claim) => claim.status === "quoted" || claim.status === "unverified",
        ),
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

function buildFindings(partition: ClaimPartition): Finding[] {
  const findings: Finding[] = [];
  let next = 1;
  for (const claim of partition.confirmed) {
    findings.push({
      id: `finding_${next++}`,
      statement: claim.text,
      confidence:
        (claim.corroboration ?? 1) > 1 ||
        claim.votes.some((vote) => !vote.refuted && vote.confidence === "high")
          ? "high"
          : "medium",
      claimIds: [claim.id],
      sourceIds: [claim.sourceId],
    });
  }
  for (const claim of partition.candidates) {
    if (claim.importance === "tangential") continue;
    findings.push({
      id: `finding_${next++}`,
      statement: claim.text,
      confidence: "low",
      claimIds: [claim.id],
      sourceIds: [claim.sourceId],
    });
  }
  return findings;
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
    const result = await generateObject({
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
    });
    return result.object.openQuestions;
  } catch {
    return [];
  }
}

function buildStats(opts: {
  rctx: RunCtx;
  partition: ClaimPartition;
  bound: { citationsBound: number; citationsUnsupported: number };
  durationMs: number;
}): RunStats {
  const { rctx, partition } = opts;
  const tokens: Record<string, { input: number; output: number }> = {};
  for (const [role, roleUsage] of rctx.usage.byRole) {
    tokens[role] = {
      input: roleUsage.input + roleUsage.cacheRead + roleUsage.cacheWrite,
      output: roleUsage.output,
    };
  }
  return {
    effort: rctx.config.effort,
    searches: rctx.counters.searches,
    sourcesFetched: rctx.counters.sourcesFetched,
    sourcesFailed: rctx.counters.sourcesFailed,
    claimsExtracted: rctx.ledger.representatives().length,
    claimsUnsupported: rctx.ledger.unsupportedCount,
    claimsVerified: rctx.counters.claimsVerified,
    claimsConfirmed: partition.confirmed.length,
    claimsContested: partition.contested.length,
    claimsRefuted: partition.refuted.length,
    citationsBound: opts.bound.citationsBound,
    citationsUnsupported: opts.bound.citationsUnsupported,
    dupesDropped: rctx.ledger.dupesDropped,
    agentsSpawned: rctx.counters.agentsSpawned,
    maxDepth: rctx.counters.maxDepth,
    singleAgent: rctx.counters.agentsSpawned === 0,
    tokens,
    costUSD: Math.round(rctx.meter.totalSpentUSD() * 10_000) / 10_000,
    durationMs: opts.durationMs,
    budgetExhausted: rctx.meter.totalSpentUSD() >= rctx.meter.totalUSD - 0.01,
  };
}

export async function resumeRun(
  runId: string,
  config: AtlasConfig,
): Promise<ResearchRun> {
  const store = config.store;
  if (!store) {
    throw new AtlasError(
      "Atlas.resume requires config.store (the store the original run journaled to)",
      "resume",
    );
  }
  const meta = await loadRunMeta(store, runId);
  if (!meta || typeof meta.question !== "string") {
    throw new AtlasError(`no journaled run found for "${runId}"`, "resume");
  }
  const replay = await loadReplayCache(store, runId);
  const options: ResearchOptions = {
    runId,
    ...(typeof meta.effort === "string"
      ? { effort: meta.effort as ResearchOptions["effort"] }
      : {}),
    ...(typeof meta.budgetUSD === "number"
      ? { budget: { maxUSD: meta.budgetUSD } }
      : {}),
  };
  return startRun({
    config,
    question: meta.question,
    options,
    replay,
  });
}
