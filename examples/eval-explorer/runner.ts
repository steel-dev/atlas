import { Atlas } from "../../src/atlas.js";
import type {
  ResearchEvent,
  ResearchResult,
  ResearchStream,
} from "../../src/research.js";
import {
  buildResearchRunOptions,
  effectiveLeafModel,
  gradeResearch,
  type DracoCase,
  type EvalOptions,
  type EvalResult,
  type JudgeSpec,
} from "../../evals/draco.js";
import { traceEvent, type EvalTraceEvent } from "../../evals/lib.js";
import { captureCommit, type CommitInfo } from "./git.js";
import type { Store } from "./store.js";

export type RunPhase =
  | "queued"
  | "researching"
  | "grading"
  | "persisting"
  | "done"
  | "error"
  | "stopped";

export type WireEvent =
  | ResearchEvent
  | { type: "error"; message: string }
  | { type: "phase"; phase: RunPhase }
  | { type: "grade_progress"; done: number; total: number }
  | {
      type: "grade_finished";
      status: string;
      normalized: number | null;
      passRate: number | null;
    }
  | { type: "persisted"; commit: string; caseId: string };

type Subscriber = (event: WireEvent | null, seq: number) => void;

interface DracoRunEntry {
  id: string;
  caseId: string;
  domain: string;
  dracoCase: DracoCase;
  commitSha: string;
  dirty: boolean;
  run?: ResearchStream;
  log: WireEvent[];
  subs: Set<Subscriber>;
  phase: RunPhase;
  startedAt: number;
  endedAt?: number;
  error?: string;
  sources: number;
  confirmed: number;
  angles: number;
  gradeDone: number;
  gradeTotal: number;
}

export interface DracoRunHostOptions {
  atlas: Atlas;
  opts: EvalOptions;
  judge: JudgeSpec | null;
  store: Store;
  researchProvider: string;
  researchModel: string;
  startupCommit: CommitInfo;
  maxConcurrent?: number;
}

const MAX_RUNS = 200;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DracoRunHost {
  private readonly runs = new Map<string, DracoRunEntry>();
  private readonly queue: DracoRunEntry[] = [];
  private readonly atlas: Atlas;
  private readonly opts: EvalOptions;
  private readonly judge: JudgeSpec | null;
  private readonly store: Store;
  private readonly researchProvider: string;
  private readonly researchModel: string;
  private readonly startupCommit: CommitInfo;
  private readonly maxConcurrent: number;
  private active = 0;
  private counter = 0;

  constructor(options: DracoRunHostOptions) {
    this.atlas = options.atlas;
    this.opts = options.opts;
    this.judge = options.judge;
    this.store = options.store;
    this.researchProvider = options.researchProvider;
    this.researchModel = options.researchModel;
    this.startupCommit = options.startupCommit;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
  }

  get canRun(): boolean {
    return this.judge !== null;
  }

  enqueue(caseId: string): DracoRunEntry {
    if (!this.judge) throw new Error("judge not configured");
    const dracoCase = this.loadCase(caseId);
    const current = captureCommit();
    if (current.sha !== this.startupCommit.sha) {
      process.stderr.write(
        `draco-explore: ⚠ STALE CODE — server is running ${this.startupCommit.shortSha}, HEAD is now ${current.shortSha}. Runs are tagged ${this.startupCommit.shortSha} (the loaded code); restart the server to test HEAD.\n`,
      );
    }
    const id = "run_" + Date.now().toString(36) + (this.counter++).toString(36);
    const entry: DracoRunEntry = {
      id,
      caseId,
      domain: dracoCase.domain,
      dracoCase,
      commitSha: this.startupCommit.sha,
      dirty: this.startupCommit.dirty,
      log: [],
      subs: new Set(),
      phase: "queued",
      startedAt: Date.now(),
      sources: 0,
      confirmed: 0,
      angles: 0,
      gradeDone: 0,
      gradeTotal: dracoCase.criteria.length,
    };
    this.runs.set(id, entry);
    this.queue.push(entry);
    this.evict();
    this.pump();
    return entry;
  }

  enqueueUnrun(commit: string): string[] {
    const ids = this.store.unrunCaseIds(commit);
    return ids.map((caseId) => this.enqueue(caseId).id);
  }

  get(id: string): DracoRunEntry | undefined {
    return this.runs.get(id);
  }

  attach(entry: DracoRunEntry, fn: Subscriber): void {
    entry.subs.add(fn);
  }

  detach(entry: DracoRunEntry, fn: Subscriber): void {
    entry.subs.delete(fn);
  }

  stop(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry) return false;
    if (entry.phase === "queued") {
      entry.phase = "stopped";
      entry.endedAt = Date.now();
      return true;
    }
    if (entry.run && entry.phase === "researching") {
      entry.run.stop();
      return true;
    }
    return false;
  }

  abort(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry) return false;
    if (entry.phase === "queued") {
      entry.phase = "stopped";
      entry.endedAt = Date.now();
      return true;
    }
    if (
      entry.run &&
      (entry.phase === "researching" || entry.phase === "grading")
    ) {
      entry.run.abort();
      return true;
    }
    return false;
  }

  list(): Array<Record<string, unknown>> {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((entry) => ({
        id: entry.id,
        caseId: entry.caseId,
        domain: entry.domain,
        phase: entry.phase,
        commit: entry.commitSha,
        dirty: entry.dirty,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt ?? null,
        sources: entry.sources,
        confirmed: entry.confirmed,
        angles: entry.angles,
        gradeDone: entry.gradeDone,
        gradeTotal: entry.gradeTotal,
        error: entry.error ?? null,
      }));
  }

  private loadCase(caseId: string): DracoCase {
    const row = this.store.caseRubric(caseId);
    if (!row) throw new Error(`case not found: ${caseId}`);
    return {
      id: caseId,
      domain: (row.domain as string) ?? "Unknown",
      problem: (row.problem as string) ?? "",
      rubricId: caseId,
      sections: JSON.parse((row.sections_json as string) ?? "[]"),
      criteria: JSON.parse((row.criteria_json as string) ?? "[]"),
      raw: {},
    };
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry || entry.phase !== "queued") continue;
      this.active++;
      entry.startedAt = Date.now();
      void this.execute(entry).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async execute(entry: DracoRunEntry): Promise<void> {
    const started = Date.now();
    const trace: EvalTraceEvent[] = [];
    const push = (event: WireEvent) => {
      entry.log.push(event);
      const seq = entry.log.length;
      for (const fn of entry.subs) fn(event, seq);
    };
    process.stderr.write(
      `draco-explore: ${entry.caseId} [${entry.domain}] start (commit ${entry.commitSha.slice(0, 10)}${entry.dirty ? "+dirty" : ""})\n`,
    );
    try {
      entry.phase = "researching";
      push({ type: "phase", phase: "researching" });
      const run = this.atlas.stream(entry.dracoCase.problem, {
        ...buildResearchRunOptions(this.opts),
        // Full visibility for offline analysis: capture the byte-exact model
        // transcript and keep every fetched source's body.
        recordTranscript: true,
        includeSourceDocuments: true,
      });
      entry.run = run;
      for await (const event of run.fullStream) {
        if (event.type === "scope_completed")
          entry.angles = event.angles.length;
        else if (event.type === "source_fetched") entry.sources++;
        else if (
          event.type === "claim_verified" &&
          event.status === "confirmed"
        )
          entry.confirmed++;
        const traced = traceEvent(event, started);
        if (traced) trace.push(traced);
        push(event);
      }
      const result = await run.result;
      entry.phase = "grading";
      entry.gradeTotal = entry.dracoCase.criteria.length;
      push({ type: "phase", phase: "grading" });
      const judge = this.judge;
      if (!judge) throw new Error("judge not configured");
      const evalResult = await gradeResearch(
        entry.dracoCase,
        this.opts,
        judge,
        result,
        trace,
        started,
        (done, total) => {
          entry.gradeDone = done;
          entry.gradeTotal = total;
          push({ type: "grade_progress", done, total });
        },
      );
      push({
        type: "grade_finished",
        status: evalResult.score ? "scored" : "ungraded",
        normalized: evalResult.score?.normalizedScore ?? null,
        passRate: evalResult.score?.passRate ?? null,
      });
      entry.phase = "persisting";
      this.persist(entry, evalResult, result);
      push({
        type: "persisted",
        commit: entry.commitSha,
        caseId: entry.caseId,
      });
      entry.phase = "done";
      process.stderr.write(
        `draco-explore: ${entry.caseId} done — ${
          evalResult.score
            ? `${(evalResult.score.normalizedScore * 100).toFixed(1)}%`
            : "ungraded"
        }\n`,
      );
    } catch (err) {
      const message = messageOf(err);
      entry.error = message;
      entry.phase = "error";
      this.persistError(entry, message, Date.now() - started);
      push({ type: "error", message });
      process.stderr.write(
        `draco-explore: ${entry.caseId} error — ${message}\n`,
      );
    } finally {
      entry.endedAt = Date.now();
      for (const fn of entry.subs) fn(null, entry.log.length);
    }
  }

  private persistMeta(entry: DracoRunEntry) {
    return {
      runId: entry.id,
      commitSha: entry.commitSha,
      dirty: entry.dirty,
      source: "run",
      researchProvider: this.researchProvider,
      researchModel: this.researchModel,
      judgeProvider: this.judge?.provider ?? null,
      judgeModel: this.judge?.modelId ?? null,
      grader: this.opts.grader,
      createdAt: Date.now(),
    };
  }

  private persist(
    entry: DracoRunEntry,
    evalResult: EvalResult,
    result: ResearchResult,
  ): void {
    const leafModelId = effectiveLeafModel(this.opts) ?? this.researchModel;
    this.store.insertRun(
      {
        ...evalResult,
        claims: result.claims,
        sources: result.sourceDocuments,
        citations: {
          citedSources: result.citedSources,
          citationsNotConfirmed: result.citationsNotConfirmed,
          citationsNotFetched: result.citationsNotFetched,
        },
        transcript: result.transcript,
        usage: {
          research: {
            input: result.leadUsage.input_tokens,
            output: result.leadUsage.output_tokens,
            cacheRead: result.leadUsage.cache_read_input_tokens,
            cacheWrite: result.leadUsage.cache_creation_input_tokens,
            model: this.researchModel,
          },
          ...(leafModelId !== this.researchModel
            ? {
                leaf: {
                  input: result.leafUsage.input_tokens,
                  output: result.leafUsage.output_tokens,
                  cacheRead: result.leafUsage.cache_read_input_tokens,
                  cacheWrite: result.leafUsage.cache_creation_input_tokens,
                  model: leafModelId,
                },
              }
            : {}),
          judge: evalResult.judgeUsage
            ? {
                input: evalResult.judgeUsage.inputTokens,
                output: evalResult.judgeUsage.outputTokens,
                cacheRead: evalResult.judgeUsage.cacheReadInputTokens,
                cacheWrite: evalResult.judgeUsage.cacheWriteInputTokens,
                calls: evalResult.judgeUsage.calls,
                model: this.judge?.modelId ?? null,
                gradeRuns: this.opts.gradeRuns ?? null,
              }
            : null,
        },
      },
      this.persistMeta(entry),
    );
  }

  private persistError(
    entry: DracoRunEntry,
    message: string,
    latencyMs: number,
  ): void {
    this.store.insertRun(
      {
        id: entry.caseId,
        domain: entry.domain,
        error: message,
        latencyMs,
      },
      this.persistMeta(entry),
    );
  }

  private evict(): void {
    if (this.runs.size <= MAX_RUNS) return;
    const finished = [...this.runs.values()]
      .filter(
        (entry) =>
          entry.phase === "done" ||
          entry.phase === "error" ||
          entry.phase === "stopped",
      )
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const entry of finished) {
      if (this.runs.size <= MAX_RUNS) break;
      this.runs.delete(entry.id);
    }
  }
}
