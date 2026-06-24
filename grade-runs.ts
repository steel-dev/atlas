import {
  buildEvalOptions,
  buildJudgeSpec,
  gradeRubric,
  aggregateGrading,
  type DracoCase,
  type CriterionReport,
} from "./evals/draco.js";
import { Store } from "./examples/eval-explorer/store.js";
import { DatabaseSync } from "node:sqlite";

try {
  process.loadEnvFile();
} catch {
  void 0;
}

const DB = process.env.MEASURE_DB ?? "eval-runs/smoke-redesign.db";
const T = 1782270000000;
const SET8 = [
  "82508e50-497c-445a-b1dd-fd9d7e6dafda", "a88bef13-7db6-4236-bdfa-da22ad75dc56",
  "67dfb8ea-cc84-4fb9-abc2-4794aa20eb44", "69e0ce73-b0af-4f7c-a59d-71c96adc6a2b",
  "785c8570-6aed-4517-aac2-1d56e16745b7", "b0f9b509-dff8-4414-9404-fe0a35c43107",
  "bfdf5b0d-efe9-48fc-9399-2127f71e52c7", "e1f2c310-d311-49da-b0e4-ee855603469d",
  "ebac60ea-ea67-4b8f-986e-1e0aebed2b89", "eb3965d1-c466-4c4c-bd4a-c8a0b255b893",
];
const gradeRuns = Math.max(1, Number(process.env.MEASURE_GRADE_RUNS ?? "3"));

const opts = buildEvalOptions({
  judgeProvider: "openai",
  judgeModel: "gpt-5.4",
  grader: "per-criterion",
  gradeRuns,
  judgeConcurrency: 3,
});
const judge = buildJudgeSpec(opts);
const store = new Store(DB);

function loadCase(caseId: string): DracoCase {
  const row = store.caseRubric(caseId);
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

const q = new DatabaseSync(DB, { readOnly: true });
const ph = SET8.map(() => "?").join(",");
const targets = q
  .prepare(
    `SELECT run_id, case_id, domain, research_model FROM runs
     WHERE status != 'scored' AND research_model IN ('claude-opus-4-8','agent-xhigh')
       AND created_at > ? AND case_id IN (${ph})
     ORDER BY research_model, case_id`,
  )
  .all(T, ...SET8) as Array<{ run_id: string; case_id: string; domain: string; research_model: string }>;
q.close();

process.stderr.write(
  `grade-runs: ${targets.length} ungraded runs, k=${gradeRuns}, judge=${judge.provider}/${judge.modelId}, judgeConc=${opts.judgeConcurrency}\n`,
);

for (const t of targets) {
  const md = store.getBlob(t.run_id, "markdown") ?? "";
  if (!md.trim()) {
    process.stderr.write(`  SKIP ${t.run_id} empty markdown\n`);
    continue;
  }
  const dc = loadCase(t.case_id);
  const sets: CriterionReport[][] = [];
  for (let k = 0; k < gradeRuns; k++) {
    sets.push(
      await gradeRubric({
        judge,
        grader: opts.grader,
        criteria: dc.criteria,
        response: md,
        query: dc.problem,
        concurrency: opts.judgeConcurrency,
        timeoutMs: opts.judgeTimeoutMs,
      }),
    );
  }
  const { report, score } = aggregateGrading(sets, dc);
  store.updateGrade(t.run_id, score, report, 0, {
    provider: judge.provider,
    model: judge.modelId,
    grader: opts.grader,
  });
  process.stderr.write(
    `  ${t.research_model.padEnd(16)} ${t.domain.slice(0, 16).padEnd(16)} ${
      score ? (score.normalizedScore * 100).toFixed(1) + "%" : "UNGRADED"
    } ${t.run_id}\n`,
  );
}
process.stderr.write("grade-runs: done\n");
