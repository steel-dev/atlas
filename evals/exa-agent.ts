import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { sleep } from "../src/async.js";
import { DEFAULT_CASES_URL, readCases, type DracoCase } from "./draco.js";
import { mapWithConcurrency, readEnv, writeJsonl } from "./lib.js";

const API_BASE = "https://api.exa.ai/agent/runs";
const POLL_INTERVAL_MS = 4_000;
const RUN_TIMEOUT_MS = Number(process.env.EXA_RUN_TIMEOUT_MS ?? "1200000");
const MAX_FETCH_TRIES = 6;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

export interface ExaRun {
  id: string;
  status: string;
  output?: { text?: string; structured?: unknown; grounding?: unknown } | null;
  costDollars?: unknown;
}

function backoff(tries: number): number {
  return Math.min(30_000, 1_000 * 2 ** (tries - 1));
}

export async function exaFetch(
  url: string,
  apiKey: string,
  init?: RequestInit,
): Promise<ExaRun> {
  let tries = 0;
  for (;;) {
    tries++;
    try {
      const resp = await fetch(url, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          ...(init?.headers ?? {}),
        },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        if ((resp.status === 429 || resp.status >= 500) && tries < MAX_FETCH_TRIES) {
          await sleep(backoff(tries));
          continue;
        }
        throw new Error(`exa-agent: HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      return (await resp.json()) as ExaRun;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        tries < MAX_FETCH_TRIES &&
        /fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network/i.test(
          msg,
        )
      ) {
        await sleep(backoff(tries));
        continue;
      }
      throw err;
    }
  }
}

export interface ExaResultRow {
  type: "result";
  id: string;
  domain: string;
  problem: string;
  runId: string;
  status: string;
  effort: string;
  latencyMs: number;
  costDollars: unknown;
  reportChars: number;
  report: string;
  grounding?: unknown;
  error?: string;
}

export async function runExaAgent(
  entry: DracoCase,
  effort: string,
  apiKey: string,
): Promise<ExaResultRow> {
  const started = Date.now();
  const created = await exaFetch(API_BASE, apiKey, {
    method: "POST",
    body: JSON.stringify({ query: entry.problem, effort }),
  });
  let run = created;
  while (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "cancelled"
  ) {
    if (Date.now() - started > RUN_TIMEOUT_MS) {
      throw new Error(`timeout after ${RUN_TIMEOUT_MS}ms (status=${run.status})`);
    }
    await sleep(POLL_INTERVAL_MS);
    run = await exaFetch(`${API_BASE}/${created.id}`, apiKey);
  }
  const text = run.output?.text ?? "";
  return {
    type: "result",
    id: entry.id,
    domain: entry.domain,
    problem: entry.problem,
    runId: created.id,
    status: run.status,
    effort,
    latencyMs: Date.now() - started,
    costDollars: run.costDollars ?? null,
    reportChars: text.length,
    report: text,
    ...(run.output?.grounding !== undefined
      ? { grounding: run.output.grounding }
      : {}),
  };
}

async function main(): Promise<void> {
  const apiKey = readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY");
  if (!apiKey) throw new Error("set EXA_API_KEY (or ATLAS_EXA_API_KEY)");
  const casesPath = arg("--cases", DEFAULT_CASES_URL);
  const effort = arg("--effort", "high");
  const concurrency = Math.max(1, Number(arg("--concurrency", "2")));
  const outPath = arg("--out", "eval-runs/exa-agent.jsonl");
  const idsArg = arg("--case-ids", "");
  const ids = new Set(
    idsArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const cases = await readCases(casesPath);
  const selected = ids.size > 0 ? cases.filter((c) => ids.has(c.id)) : cases;
  if (selected.length === 0) throw new Error("no cases selected");

  process.stderr.write(
    `exa-agent: ${selected.length} case(s), effort=${effort}, concurrency=${concurrency}\n`,
  );

  const rows = await mapWithConcurrency<DracoCase, ExaResultRow>(
    selected,
    concurrency,
    async (entry) => {
      try {
        const row = await runExaAgent(entry, effort, apiKey);
        const cost =
          row.costDollars && typeof row.costDollars === "object"
            ? (row.costDollars as { total?: number }).total
            : undefined;
        process.stderr.write(
          `exa-agent: ${entry.id} [${entry.domain}] ${row.status} ${row.reportChars} chars $${cost ?? "?"} ${Math.round(row.latencyMs / 1000)}s\n`,
        );
        return row;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`exa-agent: ${entry.id} [${entry.domain}] FAILED ${msg}\n`);
        return {
          type: "result",
          id: entry.id,
          domain: entry.domain,
          problem: entry.problem,
          runId: "",
          status: "failed",
          effort,
          latencyMs: 0,
          costDollars: null,
          reportChars: 0,
          report: "",
          error: msg,
        };
      }
    },
  );

  await writeJsonl(outPath, rows);
  const ok = rows.filter((r) => r.status === "completed" && r.reportChars > 0);
  const totalCost = rows.reduce((sum, r) => {
    const c =
      r.costDollars && typeof r.costDollars === "object"
        ? (r.costDollars as { total?: number }).total ?? 0
        : 0;
    return sum + c;
  }, 0);
  process.stdout.write(
    `exa-agent: ${ok.length}/${rows.length} completed, total $${totalCost.toFixed(3)}, out: ${outPath}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `exa-agent: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
