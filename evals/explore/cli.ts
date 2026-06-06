import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Atlas } from "../../src/atlas.js";
import { steel } from "../../src/steel.js";
import { resolveModelSpec } from "../../src/config-resolution.js";
import type { ModelProvider, VerifierPanelMode } from "../../src/research.js";
import {
  buildEvalOptions,
  buildJudgeSpec,
  resolveResearchModel,
  resolveResearchProvider,
  DEFAULT_CASES_URL,
  type EvalOptions,
  type JudgeSpec,
} from "../draco.js";
import { DracoRunHost } from "./runner.js";
import { serveExplore } from "./server.js";
import { Store } from "./store.js";

const USAGE = `draco explore — local web UI to inspect & run the DRACO benchmark per atlas commit

Usage:
  npm run eval:draco:explore -- [options]

The run-config flags mirror eval:draco (so explorer-triggered scores are
comparable to eval-runs/*.jsonl). Pass --timeout 2700 --token-limit 4000000
--judge-model claude-opus-4-6 to reproduce a draco-v3-style run.

Options:
      --port N              Port (default: 4318)
      --host HOST           Bind host (default: 127.0.0.1)
      --provider NAME       Research provider: anthropic, openai
      --model NAME          Research model
      --judge-provider P    Judge provider: google, anthropic, openai
      --judge-model MODEL   Judge model
      --grader MODE         per-criterion | one-shot (default: per-criterion)
      --verifier-panel MODE lens | clone (default: lens)
      --timeout N           Per-run research timeout in seconds (default: 3600; 0 = unlimited)
      --token-limit N       Per-run token budget (default: 10000000; 0 = unlimited)
      --grade-runs N        Independent judge gradings per case, averaged ± SD (default: 5, DRACO)
      --concurrency N       Max simultaneous runs (default: 1)
      --proxy               Route Steel calls through proxy
      --db PATH             SQLite path (default: eval-runs/draco-explore.db)
      --cases URL|FILE      DRACO cases source (default: pinned perplexity-ai/draco)
      -h, --help            Show this help
`;

const EXPLORE_DEFAULT_TIMEOUT_MS = 3_600_000;
const EXPLORE_DEFAULT_TOKEN_LIMIT = 10_000_000;

function fail(message: string): never {
  process.stderr.write(`draco-explore: ${message}\n`);
  process.exit(1);
}

function parseProvider(raw: string | undefined): ModelProvider | undefined {
  if (raw === undefined) return undefined;
  if (raw === "anthropic" || raw === "openai") return raw;
  fail(`--provider must be one of: anthropic, openai (got "${raw}")`);
}

function parseJudgeProvider(
  raw: string | undefined,
): "google" | "anthropic" | "openai" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "google" || raw === "anthropic" || raw === "openai") return raw;
  fail(
    `--judge-provider must be one of: google, anthropic, openai (got "${raw}")`,
  );
}

function parseGrader(
  raw: string | undefined,
): "per-criterion" | "one-shot" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "per-criterion" || raw === "one-shot") return raw;
  fail(`--grader must be one of: per-criterion, one-shot (got "${raw}")`);
}

function parseVerifierPanel(
  raw: string | undefined,
): VerifierPanelMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === "lens" || raw === "clone") return raw;
  fail(`--verifier-panel must be one of: lens, clone (got "${raw}")`);
}

function parseSeconds(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    fail(`--timeout must be >= 0 (got "${raw}")`);
  return n === 0 ? undefined : Math.floor(n * 1000);
}

function parseTokenLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`--token-limit must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${name} must be a positive integer (got "${raw}")`);
  }
  return n;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file present — rely on the ambient environment */
  }

  const parsed = (() => {
    try {
      return parseArgs({
        args: process.argv.slice(2),
        allowPositionals: false,
        options: {
          port: { type: "string" },
          host: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          "judge-provider": { type: "string" },
          "judge-model": { type: "string" },
          grader: { type: "string" },
          "verifier-panel": { type: "string" },
          timeout: { type: "string" },
          "token-limit": { type: "string" },
          "grade-runs": { type: "string" },
          concurrency: { type: "string" },
          proxy: { type: "boolean" },
          db: { type: "string" },
          cases: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  })();
  const { values } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const port = values.port === undefined ? 4318 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`--port must be a valid port 0-65535 (got "${values.port}")`);
  }

  const provider = parseProvider(values.provider);
  const judgeProvider = parseJudgeProvider(values["judge-provider"]);
  const grader = parseGrader(values.grader);
  const verifierPanel = parseVerifierPanel(values["verifier-panel"]);
  const timeoutMs =
    values.timeout !== undefined
      ? parseSeconds(values.timeout)
      : EXPLORE_DEFAULT_TIMEOUT_MS;
  const tokenLimit =
    values["token-limit"] !== undefined
      ? parseTokenLimit(values["token-limit"])
      : EXPLORE_DEFAULT_TOKEN_LIMIT;
  const concurrency = parsePositiveInt(values.concurrency, "--concurrency", 1);
  const gradeRuns = parsePositiveInt(values["grade-runs"], "--grade-runs", 5);

  const opts: EvalOptions = buildEvalOptions({
    ...(provider ? { provider } : {}),
    ...(values.model ? { model: values.model } : {}),
    judgeProvider: judgeProvider ?? "anthropic",
    judgeModel: values["judge-model"] ?? "claude-opus-4-6",
    ...(grader ? { grader } : {}),
    ...(verifierPanel ? { verifierPanel } : {}),
    timeoutMs,
    tokenLimit,
    gradeRuns,
    ...(values.proxy === true ? { useProxy: true } : {}),
  });

  const casesUrl = values.cases ?? DEFAULT_CASES_URL;
  const dbPath = values.db ?? "eval-runs/draco-explore.db";
  const store = new Store(dbPath);

  const researchProvider = resolveResearchProvider(opts.provider);
  const researchModel = resolveResearchModel(researchProvider, opts.model);

  let judge: JudgeSpec | null = null;
  try {
    judge = buildJudgeSpec(opts);
  } catch (err) {
    process.stderr.write(
      `draco-explore: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const { model, leafModel } = await resolveModelSpec({
    provider: opts.provider,
    model: opts.model,
  });
  const atlas = new Atlas({
    model,
    ...(leafModel ? { leafModel } : {}),
    browser: steel({ proxy: opts.useProxy }),
  });

  const runHost = new DracoRunHost({
    atlas,
    opts,
    judge,
    store,
    researchProvider,
    researchModel,
    maxConcurrent: concurrency,
  });

  const profile = {
    research: `${researchProvider}/${researchModel}`,
    judge: judge ? `${judge.provider}/${judge.modelId}` : null,
    grader: opts.grader,
    gradeRuns: opts.gradeRuns,
    verifierPanel: opts.verifierPanel ?? "lens",
    timeoutMs: opts.timeoutMs ?? null,
    tokenLimit: opts.tokenLimit ?? null,
    concurrency,
  };

  process.stderr.write(
    `draco-explore: profile research=${profile.research} judge=${profile.judge ?? "(none)"} grader=${profile.grader} grade-runs=${profile.gradeRuns} timeout=${
      opts.timeoutMs ? `${Math.round(opts.timeoutMs / 1000)}s` : "unlimited"
    } tokens=${opts.tokenLimit ?? "unlimited"}\n`,
  );

  await serveExplore({
    store,
    runHost,
    casesUrl,
    port,
    hostname: values.host ?? "127.0.0.1",
    profile,
  });
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
