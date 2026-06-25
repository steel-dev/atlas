import {
  aggregateGrading,
  type CriterionReport,
  type DracoCase,
  emptyJudgeUsage,
  gradeRubric,
  type JudgeSpec,
  type JudgeUsage,
  type RubricScore,
} from "../../evals/draco.js";
import { type EvalTraceEvent, traceEvent } from "../../evals/lib.js";
import type {
  Atlas,
  Budget,
  Effort,
  ResearchEvent,
  ResearchResult,
  ResearchRun,
  RunTrace,
  TraceMode,
} from "../../src/index.js";
import { type CommitInfo, captureCommit } from "./git.js";
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

export interface GradeConfig {
  judge: JudgeSpec;
  grader: "per-criterion" | "one-shot";
  judgeConcurrency: number;
  judgeTimeoutMs: number;
  gradeRuns?: number;
}

interface GradeOutcome {
  score?: RubricScore | undefined;
  report: CriterionReport[];
  judgeErrors: number;
  usage: JudgeUsage;
}

interface DracoRunEntry {
  id: string;
  caseId: string;
  domain: string;
  dracoCase: DracoCase;
  commitSha: string;
  dirty: boolean;
  run?: ResearchRun;
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
  store: Store;
  researchProvider: string;
  researchModel: string;
  startupCommit: CommitInfo;
  effort?: Effort;
  budget?: Budget;
  maxConcurrent?: number;
  grade?: GradeConfig;
  trace?: TraceMode;
}

const MAX_RUNS = 200;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DracoRunHost {
  private readonly runs = new Map<string, DracoRunEntry>();
  private readonly queue: DracoRunEntry[] = [];
  private readonly atlas: Atlas;
  private readonly store: Store;
  private readonly researchProvider: string;
  private readonly researchModel: string;
  private readonly startupCommit: CommitInfo;
  private readonly effort: Effort | undefined;
  private readonly budget: Budget | undefined;
  private readonly maxConcurrent: number;
  private readonly grade: GradeConfig | undefined;
  private readonly trace: TraceMode;
  private active = 0;
  private counter = 0;

  constructor(options: DracoRunHostOptions) {
    this.atlas = options.atlas;
    this.store = options.store;
    this.researchProvider = options.researchProvider;
    this.researchModel = options.researchModel;
    this.startupCommit = options.startupCommit;
    this.effort = options.effort;
    this.budget = options.budget;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.grade = options.grade;
    this.trace = options.trace ?? "full";
  }

  get canRun(): boolean {
    return true;
  }

  enqueue(caseId: string): DracoRunEntry {
    const dracoCase = this.loadCase(caseId);
    const current = captureCommit();
    if (current.sha !== this.startupCommit.sha) {
      process.stderr.write(
        `draco-explore: ⚠ STALE CODE — server is running ${this.startupCommit.shortSha}, HEAD is now ${current.shortSha}. Runs are tagged ${this.startupCommit.shortSha} (the loaded code); restart the server to test HEAD.\n`,
      );
    }
    const id = `run_${Date.now().toString(36)}${(this.counter++).toString(36)}`;
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
    return this.cancel(id);
  }

  abort(id: string): boolean {
    return this.cancel(id);
  }

  private cancel(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry) return false;
    if (entry.phase === "queued") {
      entry.phase = "stopped";
      entry.endedAt = Date.now();
      return true;
    }
    if (entry.run && entry.phase === "researching") {
      void entry.run.abort();
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
      rubricId: (row.rubric_id as string) ?? caseId,
      sections: JSON.parse((row.sections_json as string) ?? "[]"),
      criteria: JSON.parse((row.criteria_json as string) ?? "[]"),
      raw: {},
    };
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry?.phase !== "queued") continue;
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
      const run = this.atlas.start(entry.dracoCase.problem, {
        ...(this.effort ? { effort: this.effort } : {}),
        ...(this.budget ? { budget: this.budget } : {}),
        trace: this.trace,
      });
      entry.run = run;
      for await (const event of run.events()) {
        if (event.type === "agent.spawned") entry.angles++;
        else if (event.type === "source.fetched") entry.sources++;
        else if (
          event.type === "claim.verified" &&
          event.status === "confirmed"
        )
          entry.confirmed++;
        const traced = traceEvent(event, started);
        if (traced) trace.push(traced);
        push(event);
      }
      const result = await run.result();
      const runTrace = run.trace();
      const grading = this.grade
        ? await this.gradeRun(entry, result, push, this.grade)
        : undefined;
      push({
        type: "grade_finished",
        status: grading?.score ? "scored" : "ungraded",
        normalized: grading?.score?.normalizedScore ?? null,
        passRate: grading?.score?.passRate ?? null,
      });
      entry.phase = "persisting";
      this.persist(
        entry,
        result,
        trace,
        Date.now() - started,
        grading,
        runTrace,
      );
      push({
        type: "persisted",
        commit: entry.commitSha,
        caseId: entry.caseId,
      });
      entry.phase = "done";
      const verdict = grading?.score
        ? `scored ${(grading.score.normalizedScore * 100).toFixed(1)}% (pass ${(grading.score.passRate * 100).toFixed(0)}%)`
        : "ungraded";
      process.stderr.write(
        `draco-explore: ${entry.caseId} done — ${verdict} ($${result.stats.costUSD.toFixed(4)}, ${result.sources.length} sources)\n`,
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

  private async gradeRun(
    entry: DracoRunEntry,
    result: ResearchResult,
    push: (event: WireEvent) => void,
    grade: GradeConfig,
  ): Promise<GradeOutcome> {
    entry.phase = "grading";
    push({ type: "phase", phase: "grading" });
    entry.gradeDone = 0;
    entry.gradeTotal = entry.dracoCase.criteria.length;
    const usage = emptyJudgeUsage();
    const gradeRuns = Math.max(1, grade.gradeRuns ?? 1);
    const reportSets: CriterionReport[][] = [];
    for (let k = 0; k < gradeRuns; k++) {
      const reports = await gradeRubric({
        judge: grade.judge,
        grader: grade.grader,
        criteria: entry.dracoCase.criteria,
        response: result.report,
        query: entry.dracoCase.problem,
        concurrency: grade.judgeConcurrency,
        timeoutMs: grade.judgeTimeoutMs,
        usage,
        onProgress: (done, total) => {
          entry.gradeDone = done;
          entry.gradeTotal = total;
          push({ type: "grade_progress", done, total });
        },
      });
      reportSets.push(reports);
    }
    const { report, score } = aggregateGrading(reportSets, entry.dracoCase);
    const judgeErrors = report.filter((r) => r.judgeError).length;
    return { score, report, judgeErrors, usage };
  }

  private persistMeta(entry: DracoRunEntry, graded: boolean) {
    return {
      runId: entry.id,
      commitSha: entry.commitSha,
      dirty: entry.dirty,
      source: "run",
      researchProvider: this.researchProvider,
      researchModel: this.researchModel,
      judgeProvider: graded && this.grade ? this.grade.judge.provider : null,
      judgeModel: graded && this.grade ? this.grade.judge.modelId : null,
      grader: graded && this.grade ? this.grade.grader : null,
      createdAt: Date.now(),
    };
  }

  private persist(
    entry: DracoRunEntry,
    result: ResearchResult,
    trace: EvalTraceEvent[],
    latencyMs: number,
    grading?: GradeOutcome,
    runTrace?: RunTrace | undefined,
  ): void {
    const tokens = Object.values(result.stats.tokens);
    const inputTokens = tokens.reduce((sum, t) => sum + t.input, 0);
    const outputTokens = tokens.reduce((sum, t) => sum + t.output, 0);
    this.store.insertRun(
      {
        id: entry.caseId,
        domain: entry.domain,
        markdown: result.report,
        ...(grading?.score ? { score: grading.score } : {}),
        ...(grading ? { report: grading.report } : {}),
        ...(grading?.judgeErrors ? { judgeErrors: grading.judgeErrors } : {}),
        metrics: {
          provider: this.researchProvider,
          model: this.researchModel,
          inputTokens,
          outputTokens,
        },
        usage: {
          research: {
            input: inputTokens,
            output: outputTokens,
            model: this.researchModel,
          },
          judge: grading?.usage ?? null,
        },
        diagnostics: {
          stats: result.stats,
          openQuestions: result.openQuestions,
          unboundCitations: result.unboundCitations,
        },
        trace,
        claims: result.claims,
        sources: result.sources,
        citations: { citations: result.citations },
        ...(runTrace?.steps ? { transcript: runTrace.steps } : {}),
        ...(runTrace?.spans ? { spans: runTrace.spans } : {}),
        ...(runTrace?.digest ? { digest: runTrace.digest } : {}),
        finishReason: result.stats.budgetExhausted
          ? "budget-exhausted"
          : "completed",
        latencyMs,
      },
      this.persistMeta(entry, Boolean(grading)),
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
      this.persistMeta(entry, false),
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
