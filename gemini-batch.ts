import { aggregateGrading, type CriterionReport } from "./evals/draco.js";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const DB = process.env.MEASURE_DB ?? "eval-runs/smoke-redesign.db";
const STAGE = process.env.STAGE ?? "build";
const INPUT = process.env.INPUT ?? "eval-runs/gbatch-input.jsonl";
const RESULT = process.env.RESULT ?? "eval-runs/gbatch-output.jsonl";
const OUT = process.env.OUT ?? "eval-runs/gemini-full.jsonl";
const RUN_LIMIT = Number(process.env.RUN_LIMIT ?? "0");
const OLDEST = Number(process.env.OLDEST ?? "0");

const src = readFileSync("evals/draco.ts", "utf8");
const head = "PER_CRITERION_SYSTEM_PROMPT = `";
const after = src.slice(src.indexOf(head) + head.length);
const SYSTEM = after.slice(0, after.indexOf("`;"));

const SCHEMA = {
  type: "OBJECT",
  properties: {
    explanation: { type: "STRING" },
    criterion_status: { type: "STRING", enum: ["MET", "UNMET"] },
  },
  required: ["explanation", "criterion_status"],
  propertyOrdering: ["explanation", "criterion_status"],
};

const SYS: Record<string, string> = {
  "claude-opus-4-8": "opus",
  "gpt-5.5": "gpt",
  "agent-xhigh": "exa",
};

const q = new DatabaseSync(DB, { readOnly: true });

type Crit = {
  sectionId: string;
  id: string;
  weight: number;
  requirement: string;
};
type CaseRow = { problem: string; criteria: Crit[]; sections: unknown[] };
const caseCache = new Map<string, CaseRow>();
function loadCase(caseId: string): CaseRow {
  let c = caseCache.get(caseId);
  if (!c) {
    const row = q
      .prepare(
        "SELECT problem,criteria_json,sections_json FROM cases WHERE case_id=?",
      )
      .get(caseId) as { problem: string; criteria_json: string; sections_json: string };
    c = {
      problem: row.problem ?? "",
      criteria: JSON.parse(row.criteria_json ?? "[]"),
      sections: JSON.parse(row.sections_json ?? "[]"),
    };
    caseCache.set(caseId, c);
  }
  return c;
}
function getMd(runId: string): string {
  const row = q
    .prepare("SELECT data FROM run_blobs WHERE run_id=? AND kind='markdown'")
    .get(runId) as { data: Uint8Array } | undefined;
  return row ? gunzipSync(row.data).toString("utf8") : "";
}

type Run = {
  run_id: string;
  case_id: string;
  domain: string;
  research_model: string;
  normalized: number | null;
};
function targets(): Run[] {
  if (OLDEST > 0) {
    return q
      .prepare(
        `SELECT run_id,case_id,domain,research_model,normalized FROM runs ORDER BY created_at LIMIT ${OLDEST}`,
      )
      .all() as Run[];
  }
  const lim = RUN_LIMIT > 0 ? ` LIMIT ${RUN_LIMIT}` : "";
  return q
    .prepare(
      `SELECT run_id,case_id,domain,research_model,normalized FROM runs ORDER BY case_id,research_model${lim}`,
    )
    .all() as Run[];
}

if (STAGE === "build") {
  writeFileSync(INPUT, "");
  let lines = 0;
  for (const t of targets()) {
    const md = getMd(t.run_id);
    if (!md.trim()) continue;
    const c = loadCase(t.case_id);
    let buf = "";
    c.criteria.forEach((cr, i) => {
      const ctype = cr.weight < 0 ? "negative" : "positive";
      const prompt = `<criterion_type>\n${ctype}\n</criterion_type>\n\n<criterion>\n${cr.requirement}\n</criterion>\n\n<query>${c.problem}</query>\n\n<response>\n${md}\n</response>`;
      buf +=
        JSON.stringify({
          key: `${t.run_id}#${i}`,
          request: {
            system_instruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generation_config: {
              temperature: 0,
              response_mime_type: "application/json",
              response_schema: SCHEMA,
            },
          },
        }) + "\n";
      lines++;
    });
    appendFileSync(INPUT, buf);
  }
  q.close();
  process.stderr.write(`build: ${lines} requests -> ${INPUT}\n`);
} else if (STAGE === "fetch") {
  const verdicts = new Map<string, { verdict: string; reason: string }>();
  let parseErr = 0;
  for (const line of readFileSync(RESULT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      parseErr++;
      continue;
    }
    const key = (o.key ?? (o as { metadata?: { key?: string } }).metadata?.key) as string | undefined;
    if (!key) continue;
    const resp = (o.response ?? o) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let v = "UNMET",
      reason = "";
    try {
      const j = JSON.parse(text);
      v = j.criterion_status === "MET" ? "MET" : "UNMET";
      reason = typeof j.explanation === "string" ? j.explanation : "";
    } catch {
      if ((o as { error?: unknown }).error) reason = "batch_error";
      else parseErr++;
    }
    verdicts.set(key, { verdict: v, reason });
  }

  writeFileSync(OUT, "");
  const acc: Record<string, { n: number; b: number; g: number }> = {};
  let missing = 0;
  for (const t of targets()) {
    const c = loadCase(t.case_id);
    if (!c.criteria.length) continue;
    const report: CriterionReport[] = c.criteria.map((cr, i) => {
      const hit = verdicts.get(`${t.run_id}#${i}`);
      if (!hit) missing++;
      return {
        sectionId: cr.sectionId,
        id: cr.id,
        requirement: cr.requirement,
        weight: cr.weight,
        verdict: (hit?.verdict ?? "UNMET") as "MET" | "UNMET",
        reason: hit?.reason ?? "",
        ...(hit ? {} : { judgeError: "missing_from_batch" }),
      };
    });
    const entry = {
      id: t.case_id,
      domain: t.domain,
      problem: c.problem,
      rubricId: t.case_id,
      sections: c.sections,
      criteria: c.criteria,
      raw: {},
    };
    const { score } = aggregateGrading([report], entry as never);
    const gem = score ? score.normalizedScore : null;
    const sys = SYS[t.research_model] ?? t.research_model;
    const base = t.normalized;
    if (gem != null) {
      acc[sys] ??= { n: 0, b: 0, g: 0 };
      acc[sys].n++;
      if (base != null) acc[sys].b += base;
      acc[sys].g += gem;
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
        met: report.filter((r) => r.verdict === "MET").length,
        criteria: report.length,
        judge_errors: report.filter((r) => r.judgeError).length,
        k: 1,
        judge: "gemini-3.1-pro-preview",
      }) + "\n",
    );
  }
  q.close();
  const m = (s: string) =>
    acc[s] ? { b: acc[s].b / acc[s].n, g: acc[s].g / acc[s].n } : null;
  process.stderr.write(
    `fetch: parsed verdicts=${verdicts.size} parseErr=${parseErr} missing=${missing}\n`,
  );
  for (const s of ["opus", "gpt", "exa"]) {
    const x = m(s);
    if (x)
      process.stderr.write(
        `  ${s.padEnd(4)} n=${acc[s].n} baseline ${(x.b * 100).toFixed(1)} gemini ${(x.g * 100).toFixed(1)} Δ ${((x.g - x.b) * 100).toFixed(1)}\n`,
      );
  }
  const e = m("exa");
  if (e)
    for (const s of ["opus", "gpt"]) {
      const x = m(s);
      if (x)
        process.stderr.write(
          `  lead ${s}-exa: baseline ${((x.b - e.b) * 100).toFixed(1)} gemini ${((x.g - e.g) * 100).toFixed(1)}\n`,
        );
    }
  process.stderr.write(`out: ${OUT}\n`);
} else {
  q.close();
  process.stderr.write(`unknown STAGE=${STAGE}\n`);
}
