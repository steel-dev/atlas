import { Atlas } from "./src/index.js";
import {
  buildAtlasConfig,
  buildEvalOptions,
  buildJudgeSpec,
  type EvalOptions,
} from "./evals/draco.js";
import { DracoRunHost, type GradeConfig } from "./examples/eval-explorer/runner.js";
import { Store } from "./examples/eval-explorer/store.js";
import { captureCommit } from "./examples/eval-explorer/git.js";

try {
  process.loadEnvFile();
} catch {
  void 0;
}

const [provider, model, ...caseIds] = process.argv.slice(2);
if (!provider || !model || caseIds.length === 0) {
  process.stderr.write("usage: tsx run-d7-measure.ts <anthropic|openai> <model> <caseId...>\n");
  process.exit(2);
}

const budgetUSD = Number(process.env.MEASURE_BUDGET ?? "2.5");
const timeoutMs = Number(process.env.MEASURE_TIMEOUT ?? "600") * 1000;
const concurrency = Number(process.env.MEASURE_CONCURRENCY ?? "2");
const gradeRuns = Math.max(1, Number(process.env.MEASURE_GRADE_RUNS ?? "3"));
const skipGrade = process.env.MEASURE_GRADE === "0";

const opts: EvalOptions = buildEvalOptions({
  provider: provider as EvalOptions["provider"],
  model,
  judgeProvider: "openai",
  judgeModel: "gpt-5.4",
});
const config = buildAtlasConfig(opts);
const atlas = new Atlas(config);
const store = new Store(process.env.MEASURE_DB ?? "eval-runs/draco-explore.db");
const startupCommit = captureCommit();
const judge = buildJudgeSpec(opts);
const grade: GradeConfig = {
  judge,
  grader: "per-criterion",
  judgeConcurrency: 4,
  judgeTimeoutMs: 120_000,
  gradeRuns,
};

const host = new DracoRunHost({
  atlas,
  store,
  researchProvider: provider,
  researchModel: model,
  startupCommit,
  effort: "balanced",
  budget: { maxUSD: budgetUSD, maxDurationMs: timeoutMs },
  maxConcurrent: concurrency,
  ...(skipGrade ? {} : { grade }),
  trace: "full",
});

process.stderr.write(
  `measure: commit=${startupCommit.shortSha}${startupCommit.dirty ? "+dirty" : ""} research=${provider}/${model} judge=${judge.provider}/${judge.modelId} effort=balanced budget=$${budgetUSD} timeout=${timeoutMs / 1000}s conc=${concurrency} grade=${skipGrade ? "off(research-only)" : "k=" + gradeRuns} cases=${caseIds.length}\n`,
);

const ids = caseIds.map((c) => ({ caseId: c, id: host.enqueue(c).id }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const terminal = new Set(["done", "error", "stopped"]);
for (;;) {
  await sleep(4000);
  const entries = ids.map(({ id }) => host.get(id));
  const done = entries.filter((e) => e && terminal.has(e.phase)).length;
  const phases = entries.map((e) => e?.phase ?? "?").join(",");
  process.stderr.write(`  [${done}/${ids.length}] ${phases}\n`);
  if (done === ids.length) break;
}

process.stderr.write("\n=== results ===\n");
for (const { caseId, id } of ids) {
  const e = host.get(id);
  process.stderr.write(
    `${caseId} ${e?.domain ?? "?"} → ${e?.phase} runId=${id}${e?.error ? ` ERR:${e.error}` : ""} sources=${e?.sources} confirmed=${e?.confirmed}\n`,
  );
}
process.exit(0);
