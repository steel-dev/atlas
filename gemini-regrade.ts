import {
  buildEvalOptions,
  gradeRubric,
  aggregateGrading,
  type DracoCase,
  type CriterionReport,
} from "./evals/draco.js";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { appendFileSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile();
} catch {
  void 0;
}

const DB = process.env.MEASURE_DB ?? "eval-runs/smoke-redesign.db";
const OUT = process.env.OUT ?? "eval-runs/gemini-pilot.jsonl";
const MODE = process.env.MODE ?? "pilot";
const K = Math.max(1, Number(process.env.K ?? "1"));
const CONC = Math.max(1, Number(process.env.CONC ?? "10"));
const RUN_CONC = Math.max(1, Number(process.env.RUN_CONC ?? "4"));
const PER_DOMAIN = Math.max(1, Number(process.env.PER_DOMAIN ?? "1"));
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gemini-3.1-pro-preview";

const SYS: Record<string, string> = {
  "claude-opus-4-8": "opus",
  "gpt-5.5": "gpt",
  "agent-xhigh": "exa",
};

const opts = buildEvalOptions({
  judgeProvider: "google",
  judgeModel: JUDGE_MODEL,
  grader: "per-criterion",
  gradeRuns: K,
  judgeConcurrency: CONC,
});
const apiKey =
  process.env.ATLAS_GOOGLE_API_KEY ??
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
  process.env.GEMINI_API_KEY ??
  process.env.GOOGLE_API_KEY ??
  "";
const baseURL =
  process.env.GOOGLE_BASE_URL ??
  "https://generativelanguage.googleapis.com/v1alpha";
const judge = {
  provider: "google" as const,
  modelId: JUDGE_MODEL,
  model: createGoogleGenerativeAI({ apiKey, baseURL })(JUDGE_MODEL),
};

const q = new DatabaseSync(DB, { readOnly: true });

function getMarkdown(runId: string): string {
  const row = q
    .prepare("SELECT data FROM run_blobs WHERE run_id=? AND kind='markdown'")
    .get(runId) as { data: Uint8Array } | undefined;
  return row ? gunzipSync(row.data).toString("utf8") : "";
}

function loadCase(caseId: string): DracoCase {
  const row = q
    .prepare(
      "SELECT domain,problem,rubric_id,sections_json,criteria_json FROM cases WHERE case_id=?",
    )
    .get(caseId) as Record<string, string> | undefined;
  if (!row) throw new Error(`case not found: ${caseId}`);
  return {
    id: caseId,
    domain: row.domain ?? "Unknown",
    problem: row.problem ?? "",
    rubricId: row.rubric_id ?? caseId,
    sections: JSON.parse(row.sections_json ?? "[]"),
    criteria: JSON.parse(row.criteria_json ?? "[]"),
    raw: {},
  };
}

type Row = {
  run_id: string;
  case_id: string;
  domain: string;
  research_model: string;
  normalized: number | null;
};

let targets: Row[];
if (MODE === "smoke") {
  targets = q
    .prepare(
      "SELECT run_id,case_id,domain,research_model,normalized FROM runs ORDER BY case_id LIMIT 1",
    )
    .all() as Row[];
} else if (MODE === "full") {
  targets = q
    .prepare(
      "SELECT run_id,case_id,domain,research_model,normalized FROM runs ORDER BY case_id,research_model",
    )
    .all() as Row[];
} else {
  const distinct = q
    .prepare("SELECT DISTINCT case_id, domain FROM runs ORDER BY domain, case_id")
    .all() as Array<{ case_id: string; domain: string }>;
  const perDomain = new Map<string, number>();
  const pick = new Set<string>();
  for (const c of distinct) {
    const n = perDomain.get(c.domain) ?? 0;
    if (n < PER_DOMAIN) {
      pick.add(c.case_id);
      perDomain.set(c.domain, n + 1);
    }
  }
  const ph = [...pick].map(() => "?").join(",");
  targets = q
    .prepare(
      `SELECT run_id,case_id,domain,research_model,normalized FROM runs WHERE case_id IN (${ph}) ORDER BY domain,case_id,research_model`,
    )
    .all(...pick) as Row[];
}

const acc: Record<string, { n: number; base: number; gem: number }> = {};
writeFileSync(OUT, "");
process.stderr.write(
  `gemini-regrade: mode=${MODE} runs=${targets.length} k=${K} conc=${CONC} judge=${judge.provider}/${judge.modelId} out=${OUT}\n`,
);

let done = 0;
const t0 = Date.now();
async function gradeOne(t: Row): Promise<void> {
  const md = getMarkdown(t.run_id);
  if (!md.trim()) {
    process.stderr.write(`  SKIP empty markdown ${t.run_id}\n`);
    return;
  }
  const dc = loadCase(t.case_id);
  const crit = MODE === "smoke" ? dc.criteria.slice(0, 3) : dc.criteria;
  const entry = { ...dc, criteria: crit };
  const sets: CriterionReport[][] = [];
  for (let k = 0; k < K; k++) {
    sets.push(
      await gradeRubric({
        judge,
        grader: opts.grader,
        criteria: crit,
        response: md,
        query: dc.problem,
        concurrency: opts.judgeConcurrency,
        timeoutMs: opts.judgeTimeoutMs,
      }),
    );
  }
  const { report, score } = aggregateGrading(sets, entry);
  const gem = score ? score.normalizedScore : null;
  const met = report.filter((r) => r.verdict === "MET").length;
  const errs = report.filter((r) => r.judgeError).length;
  const sys = SYS[t.research_model] ?? t.research_model;
  const base = t.normalized;
  done++;
  if (gem != null) {
    acc[sys] ??= { n: 0, base: 0, gem: 0 };
    acc[sys].n++;
    if (base != null) acc[sys].base += base;
    acc[sys].gem += gem;
  }
  appendFileSync(
    OUT,
    JSON.stringify({
      run_id: t.run_id,
      case_id: t.case_id,
      domain: t.domain,
      system: sys,
      research_model: t.research_model,
      baseline_norm: base,
      gemini_norm: gem,
      delta: gem != null && base != null ? gem - base : null,
      met,
      criteria: crit.length,
      judge_errors: errs,
      k: K,
      judge: judge.modelId,
      ts: Date.now(),
    }) + "\n",
  );
  const run = ["opus", "gpt", "exa"]
    .filter((s) => acc[s])
    .map(
      (s) =>
        `${s} ${((acc[s].base / acc[s].n) * 100).toFixed(1)}→${((acc[s].gem / acc[s].n) * 100).toFixed(1)}`,
    )
    .join("  ");
  process.stderr.write(
    `  [${done}/${targets.length}] ${t.domain.slice(0, 14).padEnd(14)} ${sys.padEnd(4)} base ${base != null ? (base * 100).toFixed(1) : "--"} → gem ${gem != null ? (gem * 100).toFixed(1) : "ERR"}${errs ? ` (${errs}err)` : ""} | ${run}\n`,
  );
}
let idx = 0;
await Promise.all(
  Array.from({ length: Math.min(RUN_CONC, targets.length) }, async () => {
    while (idx < targets.length) {
      const i = idx++;
      await gradeOne(targets[i]);
    }
  }),
);
q.close();

const mean = (s: string) =>
  acc[s] ? { base: acc[s].base / acc[s].n, gem: acc[s].gem / acc[s].n } : null;
process.stderr.write(
  `\n=== SUMMARY  judge=${judge.modelId} k=${K} mins=${((Date.now() - t0) / 60000).toFixed(1)} ===\n`,
);
for (const s of ["opus", "gpt", "exa"]) {
  const m = mean(s);
  if (m)
    process.stderr.write(
      `  ${s.padEnd(4)} baseline ${(m.base * 100).toFixed(1)}  gemini ${(m.gem * 100).toFixed(1)}  Δ ${((m.gem - m.base) * 100).toFixed(1)}\n`,
    );
}
const e = mean("exa");
if (e)
  for (const s of ["opus", "gpt"]) {
    const m = mean(s);
    if (m)
      process.stderr.write(
        `  lead ${s}-vs-exa: baseline ${((m.base - e.base) * 100).toFixed(1)}  gemini ${((m.gem - e.gem) * 100).toFixed(1)}\n`,
      );
  }
process.stderr.write(`out: ${OUT}\n`);
