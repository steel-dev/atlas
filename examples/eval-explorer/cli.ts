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
import {
  DEFAULT_CASES_URL,
  DEFAULT_LEAF_MODEL,
  buildJudgeSpec,
  type EvalOptions,
} from "../../evals/draco.js";
import { DracoRunHost, type GradeConfig } from "./runner.js";
import { captureCommit } from "./git.js";
import { serveExplore } from "./server.js";
import { Store } from "./store.js";

const USAGE = `draco explore — local web UI to inspect & run the DRACO benchmark per atlas commit

Usage:
  npm run eval:draco:explore -- [options]

Runs research per case with the v2 engine. Ungraded by default; pass --grade
to judge each run against its DRACO rubric (one pass, no variance).

Options:
      --port N          Port (default: 4318)
      --host HOST       Bind host (default: 127.0.0.1)
      --provider NAME   Research provider: anthropic, openai
      --model NAME      Research (lead) model id
      --leaf-model NAME Model for extraction & verification (default: ${DEFAULT_LEAF_MODEL} on anthropic; lead model otherwise)
      --effort LEVEL    fast | balanced | deep | max (default: balanced)
      --budget USD      Per-run spend cap in USD
      --timeout N       Per-run wall-clock cap in seconds
      --concurrency N   Max simultaneous runs (default: 1)
      --db PATH         SQLite path (default: eval-runs/draco-explore.db)
      --cases URL|FILE  DRACO cases source (default: pinned perplexity-ai/draco)
      --grade           Judge each run against its DRACO rubric (off by default)
      --judge-provider P  Judge provider: google, anthropic, openai (default: anthropic)
      --judge-model M     Judge model id (default per provider)
      --grader G          per-criterion | one-shot (default: per-criterion)
      --judge-concurrency N  Parallel judge calls per run (default: 2)
      --judge-timeout N      Per-criterion judge timeout in seconds (default: 120)
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
  leafFlag: string | undefined,
): {
  provider: string;
  modelId: string;
  model: AtlasConfig["model"];
  leafModelId?: string;
  models?: AtlasConfig["models"];
} {
  const provider = providerFlag ?? readEnv("ATLAS_PROVIDER") ?? "anthropic";
  if (provider !== "anthropic" && provider !== "openai") {
    fail(`--provider must be one of: anthropic, openai (got "${provider}")`);
  }
  const modelId =
    modelFlag ??
    readEnv("ATLAS_MODEL") ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
  const make =
    provider === "anthropic"
      ? (() => {
          const apiKey = readEnv(
            "ATLAS_ANTHROPIC_API_KEY",
            "ANTHROPIC_API_KEY",
          );
          if (!apiKey)
            fail("ANTHROPIC_API_KEY is required for provider=anthropic");
          return createAnthropic({ apiKey });
        })()
      : (() => {
          const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
          if (!apiKey) fail("OPENAI_API_KEY is required for provider=openai");
          return createOpenAI({ apiKey });
        })();
  const model = make(modelId);
  const leafModelId =
    leafFlag ??
    readEnv("ATLAS_LEAF_MODEL") ??
    (provider === "anthropic" ? DEFAULT_LEAF_MODEL : undefined);
  if (leafModelId && leafModelId !== modelId) {
    const leaf = make(leafModelId);
    return {
      provider,
      modelId,
      model,
      leafModelId,
      models: { extract: leaf, verify: leaf },
    };
  }
  return { provider, modelId, model };
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
          "leaf-model": { type: "string" },
          effort: { type: "string" },
          budget: { type: "string" },
          timeout: { type: "string" },
          concurrency: { type: "string" },
          db: { type: "string" },
          cases: { type: "string" },
          grade: { type: "boolean" },
          "judge-provider": { type: "string" },
          "judge-model": { type: "string" },
          grader: { type: "string" },
          "judge-concurrency": { type: "string" },
          "judge-timeout": { type: "string" },
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

  const { provider, modelId, model, leafModelId, models } =
    resolveResearchModel(values.provider, values.model, values["leaf-model"]);
  const atlas = new Atlas({ model, ...(models ? { models } : {}) });

  let grade: GradeConfig | undefined;
  if (values.grade) {
    const judgeProvider = values["judge-provider"] ?? "anthropic";
    if (
      judgeProvider !== "google" &&
      judgeProvider !== "anthropic" &&
      judgeProvider !== "openai"
    ) {
      fail(
        `--judge-provider must be one of: google, anthropic, openai (got "${judgeProvider}")`,
      );
    }
    const grader = values.grader ?? "per-criterion";
    if (grader !== "per-criterion" && grader !== "one-shot") {
      fail(
        `--grader must be one of: per-criterion, one-shot (got "${grader}")`,
      );
    }
    let judge: ReturnType<typeof buildJudgeSpec>;
    try {
      judge = buildJudgeSpec({
        judgeProvider,
        judgeModel: values["judge-model"],
        provider,
        model: modelId,
      } as unknown as EvalOptions);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    grade = {
      judge,
      grader,
      judgeConcurrency: parsePositiveInt(
        values["judge-concurrency"],
        "--judge-concurrency",
        2,
      ),
      judgeTimeoutMs: Math.floor(
        (parsePositiveNumber(values["judge-timeout"], "--judge-timeout") ??
          120) * 1000,
      ),
    };
  }

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
    ...(grade ? { grade } : {}),
  });

  const profile = {
    research: `${provider}/${modelId}`,
    judge: grade ? `${grade.judge.provider}/${grade.judge.modelId}` : null,
    grader: grade ? grade.grader : null,
    verifierPanel: null,
    effort: effort ?? "balanced",
    budgetUSD: maxUSD ?? null,
    timeoutMs: budget.maxDurationMs ?? null,
    tokenLimit: null,
    concurrency,
  };

  process.stderr.write(
    `draco-explore: profile code=${startupCommit.shortSha}${startupCommit.dirty ? "+dirty" : ""} research=${profile.research}${leafModelId ? ` leaf=${leafModelId}` : ""} effort=${profile.effort} budget=${maxUSD !== undefined ? `$${maxUSD}` : "envelope"} timeout=${
      timeoutSeconds !== undefined ? `${timeoutSeconds}s` : "unlimited"
    } concurrency=${concurrency} ${grade ? `judge=${profile.judge} grader=${profile.grader}` : "(ungraded runs; use eval:draco for scoring)"}\n`,
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
