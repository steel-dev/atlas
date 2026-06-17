import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  readCases,
  selectCases,
  buildEvalOptions,
  DEFAULT_CASES_URL,
  type DracoCase,
} from "../evals/draco.js";

try {
  const env = readFileSync(".env", "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const API_KEY = process.env.EXA_API_KEY;
if (!API_KEY) {
  console.error("EXA_API_KEY is required (set it in .env)");
  process.exit(1);
}

const EFFORT = process.env.EXA_EFFORT ?? "high";
const LIMIT = Number(process.env.LIMIT ?? "5");
const RUN = Number(process.env.RUN ?? String(LIMIT));
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "2");
const POLL_MS = Number(process.env.POLL_MS ?? "5000");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? String(25 * 60 * 1000));
const BASE = process.env.EXA_BASE ?? "https://api.exa.ai";
const OUT = process.env.OUT ?? `eval-runs/exa-draco-${process.env.EXA_EFFORT ?? "high"}.jsonl`;

const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "error"]);

async function createRun(query: string): Promise<any> {
  const resp = await fetch(`${BASE}/agent/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY! },
    body: JSON.stringify({ query, effort: EFFORT }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`create HTTP ${resp.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

async function getRun(id: string): Promise<any> {
  const resp = await fetch(`${BASE}/agent/runs/${id}`, {
    headers: { "x-api-key": API_KEY! },
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`poll HTTP ${resp.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

async function pollUntilDone(id: string, startedAt: number): Promise<any> {
  for (;;) {
    const run = await getRun(id);
    if (TERMINAL.has(String(run.status))) return run;
    if (Date.now() - startedAt > TIMEOUT_MS)
      throw new Error(
        `timeout after ${Math.round((Date.now() - startedAt) / 1000)}s (status=${run.status})`,
      );
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function runCase(entry: DracoCase): Promise<any> {
  const startedAt = Date.now();
  process.stderr.write(`▶ ${entry.id} [${entry.domain}] creating (effort=${EFFORT})…\n`);
  const created = await createRun(entry.problem);
  const runId = created.id ?? created.runId ?? created.run?.id;
  if (!runId)
    throw new Error(`no run id in create response: ${JSON.stringify(created).slice(0, 400)}`);
  const final = TERMINAL.has(String(created.status))
    ? created
    : await pollUntilDone(runId, startedAt);
  const latencyMs = Date.now() - startedAt;
  const report = final.output?.text ?? "";
  const rec = {
    id: entry.id,
    domain: entry.domain,
    runId,
    status: final.status,
    effort: EFFORT,
    latencyMs,
    costDollars: final.costDollars ?? null,
    usage: final.usage ?? null,
    criteriaCount: entry.criteria.length,
    reportChars: report.length,
    report,
    problem: entry.problem,
  };
  await appendFile(OUT, JSON.stringify(rec) + "\n");
  process.stderr.write(
    `✓ ${entry.id} ${final.status} in ${Math.round(latencyMs / 1000)}s · cost=${JSON.stringify(rec.costDollars)} · report=${report.length} chars\n`,
  );
  return rec;
}

async function mapPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`✗ ${(items[idx] as any).id}: ${message}\n`);
        out[idx] = { id: (items[idx] as any).id, error: message } as R;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const cases = await readCases(DEFAULT_CASES_URL);
const opts = buildEvalOptions({ sample: LIMIT });
const selected = selectCases(cases, opts);
const done = new Set<string>();
try {
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const prev = JSON.parse(line);
    if (prev.status === "completed") done.add(prev.id);
  }
} catch {}
const toRun = selected.slice(0, RUN).filter((c) => !done.has(c.id));

process.stderr.write(
  `selected ${selected.length}/${cases.length} [seed=${opts.seed}, stratify=${opts.stratify}], running ${toRun.length} (effort=${EFFORT}, concurrency=${CONCURRENCY})\n`,
);
for (const c of selected)
  process.stderr.write(
    `  ${toRun.includes(c) ? "▶" : "·"} ${c.id} [${c.domain}] ${c.problem.slice(0, 70)}… (${c.criteria.length} criteria)\n`,
  );

await mkdir("eval-runs", { recursive: true });
const results = await mapPool(toRun, CONCURRENCY, runCase);

const ok = results.filter((r: any) => r && !r.error && r.status === "completed");
process.stderr.write(`\ndone: ${ok.length}/${toRun.length} completed · out=${OUT}\n`);
process.stdout.write(`${OUT}\n`);
