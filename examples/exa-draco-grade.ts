import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  readCases,
  selectCases,
  buildEvalOptions,
  buildJudgeSpec,
  gradeRubric,
  buildScore,
  emptyJudgeUsage,
  DEFAULT_CASES_URL,
} from "../evals/draco.js";

try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const EXA_OUT = process.env.EXA_OUT ?? "eval-runs/exa-draco-high.jsonl";
const GRADE_RUNS = Number(process.env.GRADE_RUNS ?? "1");
const OUT = process.env.OUT ?? "eval-runs/exa-draco-scores.jsonl";
const SAMPLE = Number(process.env.LIMIT ?? "5");

const byId = new Map<string, any>();
for (const line of readFileSync(EXA_OUT, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (r.report) byId.set(r.id, r);
}

const cases = await readCases(DEFAULT_CASES_URL);
const opts = buildEvalOptions({ sample: SAMPLE, gradeRuns: GRADE_RUNS });
const selected = selectCases(cases, opts);
const judge = buildJudgeSpec(opts);

process.stderr.write(
  `grading ${selected.length} Exa report(s) · grader=${opts.grader} · runs=${GRADE_RUNS} · judge=${judge.provider}/${judge.modelId}\n`,
);

const rows: any[] = [];
for (const entry of selected) {
  const exa = byId.get(entry.id);
  if (!exa) {
    process.stderr.write(`✗ no Exa report for ${entry.id} [${entry.domain}]\n`);
    continue;
  }
  let sumNorm = 0;
  let sumPass = 0;
  for (let run = 0; run < GRADE_RUNS; run++) {
    const reports = await gradeRubric({
      judge,
      grader: opts.grader,
      criteria: entry.criteria,
      response: exa.report,
      query: entry.problem,
      concurrency: opts.judgeConcurrency,
      timeoutMs: opts.judgeTimeoutMs,
      usage: emptyJudgeUsage(),
    });
    const score = buildScore(reports, entry);
    sumNorm += score.normalizedScore;
    sumPass += score.passRate;
  }
  const normalizedScore = sumNorm / GRADE_RUNS;
  const passRate = sumPass / GRADE_RUNS;
  rows.push({
    id: entry.id,
    domain: entry.domain,
    criteria: entry.criteria.length,
    reportChars: exa.reportChars,
    latencyMs: exa.latencyMs,
    costDollars: exa.costDollars,
    normalizedScore,
    passRate,
  });
  process.stderr.write(
    `✓ ${entry.id} [${entry.domain}] score=${(normalizedScore * 100).toFixed(1)}% pass=${(passRate * 100).toFixed(1)}%\n`,
  );
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const meanNorm = mean(rows.map((r) => r.normalizedScore));
const meanPass = mean(rows.map((r) => r.passRate));
const summary = {
  system: "exa-agent",
  effort: "high",
  grader: opts.grader,
  gradeRuns: GRADE_RUNS,
  judge: `${judge.provider}/${judge.modelId}`,
  cases: rows.length,
  meanNormalizedScore: meanNorm,
  meanPassRate: meanPass,
};
await writeFile(
  OUT,
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + JSON.stringify({ summary }) + "\n",
);

process.stderr.write(
  `\n=== Exa Agent · DRACO (${rows.length} cases, runs=${GRADE_RUNS}) ===\n` +
    `mean normalized score: ${(meanNorm * 100).toFixed(1)}%\n` +
    `mean pass rate:        ${(meanPass * 100).toFixed(1)}%\n`,
);
for (const r of rows)
  process.stderr.write(
    `  ${String(r.domain).padEnd(24)} ${(r.normalizedScore * 100).toFixed(1).padStart(5)}%  (pass ${(r.passRate * 100).toFixed(0)}%, ${r.criteria} criteria)\n`,
  );
process.stderr.write(`out=${OUT}\n`);
