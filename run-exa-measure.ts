import {
  aggregateGrading,
  buildEvalOptions,
  buildJudgeSpec,
  gradeRubric,
  type CriterionReport,
  type DracoCase,
} from "./evals/draco.js";
import { runExaAgent } from "./evals/exa-agent.js";
import { mapWithConcurrency, readEnv } from "./evals/lib.js";
import { captureCommit } from "./examples/eval-explorer/git.js";
import { Store } from "./examples/eval-explorer/store.js";

try {
  process.loadEnvFile();
} catch {
  void 0;
}

const caseIds = process.argv.slice(2);
if (caseIds.length === 0) {
  process.stderr.write("usage: tsx run-exa-measure.ts <caseId...>\n");
  process.exit(2);
}

const apiKey = readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY");
if (!apiKey) {
  process.stderr.write("run-exa-measure: set EXA_API_KEY (or ATLAS_EXA_API_KEY)\n");
  process.exit(2);
}

const effort = process.env.EXA_EFFORT ?? "xhigh";
const concurrency = Math.max(1, Number(process.env.MEASURE_CONCURRENCY ?? "2"));
const gradeRuns = Math.max(1, Number(process.env.MEASURE_GRADE_RUNS ?? "3"));
const skipGrade = process.env.MEASURE_GRADE === "0";

const store = new Store(process.env.MEASURE_DB ?? "eval-runs/draco-explore.db");
const startupCommit = captureCommit();
const opts = buildEvalOptions({
  judgeProvider: "openai",
  judgeModel: "gpt-5.4",
  grader: "per-criterion",
  gradeRuns,
  judgeConcurrency: 4,
  judgeTimeoutMs: 120_000,
});
const judge = buildJudgeSpec(opts);
const researchModel = `agent-${effort}`;

function loadCase(caseId: string): DracoCase {
  const row = store.caseRubric(caseId);
  if (!row) throw new Error(`case not found in store: ${caseId}`);
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

function meta(runId: string, graded: boolean) {
  return {
    runId,
    commitSha: startupCommit.sha,
    dirty: startupCommit.dirty,
    source: "exa",
    researchProvider: "exa",
    researchModel,
    judgeProvider: graded ? judge.provider : null,
    judgeModel: graded ? judge.modelId : null,
    grader: graded ? opts.grader : null,
    createdAt: Date.now(),
  };
}

function exaCostTotal(cost: unknown): number {
  return cost && typeof cost === "object"
    ? Number((cost as { total?: number }).total ?? 0)
    : 0;
}

process.stderr.write(
  `exa-measure: commit=${startupCommit.shortSha}${startupCommit.dirty ? "+dirty" : ""} system=exa/${researchModel} judge=${judge.provider}/${judge.modelId} k=${gradeRuns} conc=${concurrency} cases=${caseIds.length}\n`,
);

let totalCost = 0;

interface OutRow {
  caseId: string;
  domain: string;
  status: "done" | "error";
  runId: string;
  normalized: number | null;
  error?: string;
}

const rows = await mapWithConcurrency<string, OutRow>(
  caseIds,
  concurrency,
  async (caseId, index): Promise<OutRow> => {
    const runId = `run_exa_${Date.now().toString(36)}${index.toString(36)}`;
    let dracoCase: DracoCase;
    try {
      dracoCase = loadCase(caseId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`exa-measure: ${caseId} SKIP ${message}\n`);
      return { caseId, domain: "?", status: "error", runId, normalized: null, error: message };
    }
    try {
      const exa = await runExaAgent(dracoCase, effort, apiKey);
      totalCost += exaCostTotal(exa.costDollars);
      if (exa.status !== "completed" || exa.reportChars === 0) {
        const message = exa.error ?? `exa status ${exa.status}`;
        store.insertRun(
          { id: caseId, domain: dracoCase.domain, error: message, latencyMs: exa.latencyMs },
          meta(runId, false),
        );
        process.stderr.write(
          `exa-measure: ${caseId} [${dracoCase.domain}] FAILED ${message}\n`,
        );
        return { caseId, domain: dracoCase.domain, status: "error", runId, normalized: null, error: message };
      }
      const exaDiag = {
        exa: {
          runId: exa.runId,
          status: exa.status,
          costDollars: exa.costDollars,
          reportChars: exa.reportChars,
          latencyMs: exa.latencyMs,
        },
      };
      if (skipGrade) {
        store.insertRun(
          {
            id: caseId,
            domain: dracoCase.domain,
            markdown: exa.report,
            metrics: { provider: "exa", model: researchModel },
            diagnostics: exaDiag,
            finishReason: "completed",
            latencyMs: exa.latencyMs,
          },
          meta(runId, false),
        );
        process.stderr.write(
          `exa-measure: ${caseId} [${dracoCase.domain}] researched (ungraded) runId=${runId} ${exa.reportChars}c ${Math.round(exa.latencyMs / 1000)}s\n`,
        );
        return { caseId, domain: dracoCase.domain, status: "done", runId, normalized: null };
      }
      const reportSets: CriterionReport[][] = [];
      for (let k = 0; k < gradeRuns; k++) {
        reportSets.push(
          await gradeRubric({
            judge,
            grader: opts.grader,
            criteria: dracoCase.criteria,
            response: exa.report,
            query: dracoCase.problem,
            concurrency: opts.judgeConcurrency,
            timeoutMs: opts.judgeTimeoutMs,
          }),
        );
      }
      const { report, score } = aggregateGrading(reportSets, dracoCase);
      store.insertRun(
        {
          id: caseId,
          domain: dracoCase.domain,
          markdown: exa.report,
          ...(score ? { score } : {}),
          report,
          metrics: { provider: "exa", model: researchModel },
          diagnostics: exaDiag,
          finishReason: "completed",
          latencyMs: exa.latencyMs,
        },
        meta(runId, true),
      );
      const verdict = score
        ? `${(score.normalizedScore * 100).toFixed(1)}% ±${((score.normalizedScoreSD ?? 0) * 100).toFixed(1)} (pass ${(score.passRate * 100).toFixed(0)}%)`
        : "UNGRADED";
      process.stderr.write(
        `exa-measure: ${caseId} [${dracoCase.domain}] ${verdict} runId=${runId} ${exa.reportChars}c ${Math.round(exa.latencyMs / 1000)}s\n`,
      );
      return {
        caseId,
        domain: dracoCase.domain,
        status: "done",
        runId,
        normalized: score?.normalizedScore ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.insertRun(
        { id: caseId, domain: dracoCase.domain, error: message, latencyMs: 0 },
        meta(runId, false),
      );
      process.stderr.write(`exa-measure: ${caseId} [${dracoCase.domain}] ERROR ${message}\n`);
      return { caseId, domain: dracoCase.domain, status: "error", runId, normalized: null, error: message };
    }
  },
);

const scored = rows.filter((r) => r.status === "done" && r.normalized !== null);
const meanNorm =
  scored.length > 0
    ? scored.reduce((s, r) => s + (r.normalized ?? 0), 0) / scored.length
    : null;

process.stderr.write("\n=== exa results ===\n");
for (const r of rows) {
  process.stderr.write(
    `${r.caseId} ${r.domain} → ${r.status}${r.normalized !== null ? ` ${(r.normalized * 100).toFixed(1)}%` : ""}${r.error ? ` ERR:${r.error}` : ""} runId=${r.runId}\n`,
  );
}
const doneCount = rows.filter((r) => r.status === "done").length;
process.stdout.write(
  skipGrade
    ? `exa-measure: ${doneCount}/${rows.length} researched (ungraded; run grade-commit), exa-cost=$${totalCost.toFixed(2)}\n`
    : `exa-measure: ${scored.length}/${rows.length} scored, mean=${meanNorm !== null ? (meanNorm * 100).toFixed(1) + "%" : "n/a"}, exa-cost=$${totalCost.toFixed(2)}\n`,
);
process.exit(0);
