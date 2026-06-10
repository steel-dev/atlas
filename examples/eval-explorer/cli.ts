import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  Atlas,
  type AtlasConfig,
  type Budget,
  type Effort,
} from "../../src/index.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../../src/defaults.js";
import { readEnv } from "../../src/env.js";
import { DEFAULT_CASES_URL } from "../../evals/draco.js";
import { DracoRunHost } from "./runner.js";
import { captureCommit } from "./git.js";
import { serveExplore } from "./server.js";
import { Store } from "./store.js";

const USAGE = `draco explore — local web UI to inspect & run the DRACO benchmark per atlas commit

Usage:
  npm run eval:draco:explore -- [options]

Runs research per case with the v2 engine and persists ungraded results;
use eval:draco for graded benchmark runs.

Options:
      --port N          Port (default: 4318)
      --host HOST       Bind host (default: 127.0.0.1)
      --provider NAME   Research provider: anthropic, openai
      --model NAME      Research model id
      --effort LEVEL    fast | balanced | deep | max (default: balanced)
      --budget USD      Per-run spend cap in USD
      --timeout N       Per-run wall-clock cap in seconds
      --concurrency N   Max simultaneous runs (default: 1)
      --db PATH         SQLite path (default: eval-runs/draco-explore.db)
      --cases URL|FILE  DRACO cases source (default: pinned perplexity-ai/draco)
  -h, --help            Show this help
`;

function fail(message: string): never {
  process.stderr.write(`draco-explore: ${message}\n`);
  process.exit(1);
}

function parseEffort(raw: string | undefined): Effort | undefined {
  if (raw === undefined) return undefined;
  if (raw === "fast" || raw === "balanced" || raw === "deep" || raw === "max") {
    return raw;
  }
  fail(`--effort must be one of: fast, balanced, deep, max (got "${raw}")`);
}

function parsePositiveNumber(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} must be > 0 (got "${raw}")`);
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

function resolveResearchModel(
  providerFlag: string | undefined,
  modelFlag: string | undefined,
): { provider: string; modelId: string; model: AtlasConfig["model"] } {
  const provider = providerFlag ?? readEnv("ATLAS_PROVIDER") ?? "anthropic";
  if (provider !== "anthropic" && provider !== "openai") {
    fail(`--provider must be one of: anthropic, openai (got "${provider}")`);
  }
  const modelId =
    modelFlag ??
    readEnv("ATLAS_MODEL") ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) fail("ANTHROPIC_API_KEY is required for provider=anthropic");
    return { provider, modelId, model: createAnthropic({ apiKey })(modelId) };
  }
  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey) fail("OPENAI_API_KEY is required for provider=openai");
  return { provider, modelId, model: createOpenAI({ apiKey })(modelId) };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    void 0;
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
          effort: { type: "string" },
          budget: { type: "string" },
          timeout: { type: "string" },
          concurrency: { type: "string" },
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

  const effort = parseEffort(values.effort);
  const budget: Budget = {};
  const maxUSD = parsePositiveNumber(values.budget, "--budget");
  if (maxUSD !== undefined) budget.maxUSD = maxUSD;
  const timeoutSeconds = parsePositiveNumber(values.timeout, "--timeout");
  if (timeoutSeconds !== undefined) {
    budget.maxDurationMs = Math.floor(timeoutSeconds * 1000);
  }
  const concurrency = parsePositiveInt(values.concurrency, "--concurrency", 1);

  const casesUrl = values.cases ?? DEFAULT_CASES_URL;
  const dbPath = values.db ?? "eval-runs/draco-explore.db";
  const store = new Store(dbPath);

  const { provider, modelId, model } = resolveResearchModel(
    values.provider,
    values.model,
  );
  const atlas = new Atlas({ model });

  const startupCommit = captureCommit();
  const runHost = new DracoRunHost({
    atlas,
    store,
    researchProvider: provider,
    researchModel: modelId,
    startupCommit,
    ...(effort ? { effort } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    maxConcurrent: concurrency,
  });

  const profile = {
    research: `${provider}/${modelId}`,
    judge: null,
    grader: null,
    verifierPanel: null,
    effort: effort ?? "balanced",
    budgetUSD: maxUSD ?? null,
    timeoutMs: budget.maxDurationMs ?? null,
    tokenLimit: null,
    concurrency,
  };

  process.stderr.write(
    `draco-explore: profile code=${startupCommit.shortSha}${startupCommit.dirty ? "+dirty" : ""} research=${profile.research} effort=${profile.effort} budget=${maxUSD !== undefined ? `$${maxUSD}` : "envelope"} timeout=${
      timeoutSeconds !== undefined ? `${timeoutSeconds}s` : "unlimited"
    } concurrency=${concurrency} (ungraded runs; use eval:draco for scoring)\n`,
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
