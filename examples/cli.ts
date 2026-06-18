#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  Atlas,
  fileStore,
  type AtlasConfig,
  type Budget,
  type Effort,
  type ResearchEvent,
  type ResearchResult,
  type ResearchRun,
  type RunStats,
  type TraceMode,
} from "../src/index.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODEL,
} from "../src/defaults.js";
import { readEnv } from "../src/env.js";

const USAGE = `atlas — deep research from your terminal

Usage:
  tsx examples/cli.ts "<question>" [options]
  tsx examples/cli.ts --resume <runId> --store <dir>

Streams progress to stderr and the report to stdout.

Options:
      --effort LEVEL      fast | balanced | deep | max (default: balanced)
      --budget USD        Spend cap in USD (default: effort envelope)
      --timeout SECONDS   Wall-clock cap; synthesizes what it has near the deadline
      --provider NAME     anthropic | openai | zai (default: ATLAS_PROVIDER or anthropic)
      --model ID          Model id (default: ATLAS_MODEL or provider default)
      --store DIR         Journal the run to DIR (enables --resume)
      --resume RUNID      Resume a parked or failed run from --store
      --trace MODE        off | spans | full — capture a timing/cost trace +
                          bottleneck digest to eval-runs/traces/<commit>/
                          (inspect with: tsx examples/trace.ts)
  -o, --out FILE          Write the report markdown to FILE instead of stdout
      --json              Print the full ResearchResult as JSON on stdout
  -q, --quiet             Suppress progress events on stderr
  -h, --help              Show this help

Environment:
  ATLAS_PROVIDER / ATLAS_MODEL                  default provider and model
  ATLAS_CHEAP_PROVIDER / ATLAS_CHEAP_MODEL      cross-provider cheap tier for screen/entail/extract
  ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY  for provider=anthropic
  OPENAI_API_KEY    or ATLAS_OPENAI_API_KEY     for provider=openai
  ZAI_API_KEY       or ATLAS_ZAI_API_KEY        for provider=zai
  ZAI_BASE_URL      or ATLAS_ZAI_BASE_URL       optional Z.ai OpenAI-compatible endpoint
  TAVILY_API_KEY / EXA_API_KEY / BRAVE_API_KEY  optional search providers
  STEEL_API_KEY                                 optional fetch escalation

Examples:
  tsx examples/cli.ts "What changed when Cloudflare DO added SQLite?"
  tsx examples/cli.ts "..." --effort deep --budget 5 -o report.md
  tsx examples/cli.ts "..." --json > result.json
  tsx examples/cli.ts "..." --store .atlas-runs
  tsx examples/cli.ts "..." --trace full --effort balanced
  tsx examples/cli.ts --resume run_ab12cd34ef56 --store .atlas-runs
`;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function fail(message: string, code = 1): never {
  process.stderr.write(`atlas: ${message}\n`);
  process.exit(code);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function paint(color: string, text: string): string {
  const colored = !process.env.NO_COLOR && process.stderr.isTTY === true;
  return colored ? `${color}${text}${RESET}` : text;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
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

function parseEffort(raw: string | undefined): Effort | undefined {
  if (raw === undefined) return undefined;
  if (raw === "fast" || raw === "balanced" || raw === "deep" || raw === "max") {
    return raw;
  }
  fail(`--effort must be one of: fast, balanced, deep, max (got "${raw}")`);
}

function parseTrace(raw: string | undefined): TraceMode | undefined {
  if (raw === undefined) return undefined;
  if (raw === "off" || raw === "spans" || raw === "full") return raw;
  fail(`--trace must be one of: off, spans, full (got "${raw}")`);
}

function normalizeProvider(provider: string): "anthropic" | "openai" | "zai" {
  if (provider === "anthropic" || provider === "openai") return provider;
  if (provider === "zai" || provider === "z.ai" || provider === "zhipu") {
    return "zai";
  }
  fail(`provider must be one of: anthropic, openai, zai (got "${provider}")`);
}

function resolveModel(
  providerFlag: string | undefined,
  modelFlag: string | undefined,
): AtlasConfig["model"] {
  const provider = normalizeProvider(
    providerFlag ?? readEnv("ATLAS_PROVIDER") ?? "anthropic",
  );
  const modelId =
    modelFlag ??
    readEnv("ATLAS_MODEL") ??
    (provider === "anthropic"
      ? DEFAULT_ANTHROPIC_MODEL
      : provider === "openai"
        ? DEFAULT_OPENAI_MODEL
        : DEFAULT_ZAI_MODEL);
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) fail("ANTHROPIC_API_KEY is required for provider=anthropic");
    return createAnthropic({ apiKey })(modelId);
  }
  if (provider === "zai") {
    const apiKey = readEnv("ATLAS_ZAI_API_KEY", "ZAI_API_KEY");
    if (!apiKey) fail("ZAI_API_KEY is required for provider=zai");
    const baseURL =
      readEnv("ATLAS_ZAI_BASE_URL", "ZAI_BASE_URL") ?? DEFAULT_ZAI_BASE_URL;
    return createOpenAI({ apiKey, baseURL }).chat(modelId);
  }
  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey) fail("OPENAI_API_KEY is required for provider=openai");
  return createOpenAI({ apiKey })(modelId);
}

function resolveCheapModels(): AtlasConfig["models"] | undefined {
  const provider = readEnv("ATLAS_CHEAP_PROVIDER");
  const modelId = readEnv("ATLAS_CHEAP_MODEL");
  if (!provider && !modelId) return undefined;
  if (provider !== "anthropic" && provider !== "openai") {
    fail(
      `ATLAS_CHEAP_PROVIDER must be one of: anthropic, openai (got "${provider}")`,
    );
  }
  if (!modelId) {
    fail("ATLAS_CHEAP_MODEL is required when ATLAS_CHEAP_PROVIDER is set");
  }
  let model: AtlasConfig["model"];
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) {
      fail("ANTHROPIC_API_KEY is required for ATLAS_CHEAP_PROVIDER=anthropic");
    }
    model = createAnthropic({ apiKey })(modelId);
  } else {
    const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
    if (!apiKey) {
      fail("OPENAI_API_KEY is required for ATLAS_CHEAP_PROVIDER=openai");
    }
    model = createOpenAI({ apiKey })(modelId);
  }
  return { screen: model, entail: model, extract: model };
}

function formatEvent(e: ResearchEvent): string | null {
  switch (e.type) {
    case "run.started":
      return paint(
        DIM,
        `run ${e.runId} — ${e.effort} effort, $${e.budgetUSD.toFixed(2)} budget`,
      );
    case "plan.updated":
      return paint(DIM, "plan ") + truncate(e.rationale, 120);
    case "agent.spawned":
      return (
        paint(DIM, `+ ${e.role} `) +
        truncate(e.task, 90) +
        paint(DIM, ` ($${e.grantUSD.toFixed(2)}, depth ${e.depth})`)
      );
    case "agent.returned":
      return (
        paint(DIM, `- ${e.role} `) +
        `${e.claimsAdded} claim${e.claimsAdded === 1 ? "" : "s"}, $${e.spentUSD.toFixed(2)}` +
        paint(DIM, ` (${e.stopReason})`)
      );
    case "search.completed":
      return (
        paint(DIM, "  search ") +
        truncate(e.query, 90) +
        paint(DIM, ` → ${e.results} via ${e.provider}`)
      );
    case "search.failed":
      return (
        paint(YELLOW, "  ! search failed ") +
        `${truncate(e.query, 60)} — ${e.error}`
      );
    case "source.fetched":
      return (
        paint(GREEN, "  ✓ ") +
        e.url +
        paint(DIM, ` (${e.via}, ${e.chars.toLocaleString()} chars)`)
      );
    case "source.failed":
      return paint(YELLOW, `  ! ${e.url} — ${e.reason}`);
    case "extraction.completed":
      return e.error
        ? paint(YELLOW, `    ! claims: ${e.url} — ${e.error}`)
        : paint(
            DIM,
            `    ↳ ${e.count} claim${e.count === 1 ? "" : "s"}${e.unsupported > 0 ? ` (${e.unsupported} unsupported)` : ""}`,
          );
    case "claim.verified": {
      const mark =
        e.status === "confirmed" || e.status === "screened"
          ? paint(GREEN, "  ✓ ")
          : e.status === "refuted"
            ? paint(YELLOW, "  ✗ ")
            : paint(YELLOW, "  ? ");
      return mark + `${e.claimId} ${e.status}` + paint(DIM, ` (${truncate(e.votes, 60)})`);
    }
    case "report.drafting":
      return paint(DIM, "drafting report");
    case "budget.warning":
      return paint(
        YELLOW,
        `! budget ${Math.round(e.fraction * 100)}% — $${e.spentUSD.toFixed(2)} of $${e.limitUSD.toFixed(2)}`,
      );
    case "safety.flag":
      return paint(YELLOW, `! safety ${e.kind}: ${truncate(e.detail, 100)}`);
    case "pricing.missing":
      return paint(YELLOW, `! ${truncate(e.detail, 100)}`);
    case "model.fallback":
      return paint(YELLOW, `! ${truncate(e.detail, 140)}`);
    case "rate.limited":
      return paint(YELLOW, `! rate limited — waiting ${e.retryAfterSeconds}s`);
    case "tool.event":
      return paint(DIM, `  ⚙ ${e.tool}`);
    case "run.error":
      return paint(
        YELLOW,
        `! ${e.recoverable ? "recoverable " : ""}error: ${e.message}`,
      );
    default:
      return null;
  }
}

function currentCommit(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || "nocommit";
  } catch {
    return "nocommit";
  }
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function writeTrace(
  run: ResearchRun,
  question: string,
  effortLabel: string,
  stats: RunStats,
  quiet: boolean,
): void {
  const trace = run.trace();
  if (!trace) return;
  const commit = currentCommit();
  const dir = join("eval-runs", "traces", commit);
  mkdirSync(dir, { recursive: true });
  const meta = {
    runId: run.id,
    commit,
    question: question || "(resumed)",
    effort: effortLabel,
  };
  writeFileSync(
    join(dir, `${run.id}.trace.json`),
    JSON.stringify({ ...meta, spans: trace.spans, steps: trace.steps }),
  );
  const digestPath = join(dir, `${run.id}.digest.json`);
  writeFileSync(
    digestPath,
    JSON.stringify({ ...meta, stats, digest: trace.digest ?? null }, null, 2),
  );
  if (quiet) return;
  process.stderr.write(paint(DIM, `trace ${trace.mode} → ${digestPath}`) + "\n");
  const d = trace.digest;
  if (!d) return;
  process.stderr.write(
    paint(
      DIM,
      `  wall ${fmtMs(d.wallMs)} · compute ${fmtMs(d.waitVsCompute.computeMs)} / wait ${fmtMs(d.waitVsCompute.waitMs)} (ratio ${d.waitVsCompute.ratio}) · ` +
        `peak ${d.concurrency.peakModelInFlight}/${d.concurrency.gateLimitModel} model · ${d.anomalies.length} anomal${d.anomalies.length === 1 ? "y" : "ies"}`,
    ) + "\n",
  );
  const hot = d.anomalies
    .slice(0, 3)
    .map((a) => a.site ?? a.kind)
    .join(" · ");
  if (hot) process.stderr.write(paint(DIM, `  hot: ${hot}`) + "\n");
}

function footer(result: ResearchResult): string {
  const s = result.stats;
  return (
    paint(GREEN, "✓") +
    ` done — $${s.costUSD.toFixed(4)} · ${result.sources.length} source${result.sources.length === 1 ? "" : "s"} · ` +
    `${s.claimsConfirmed} confirmed / ${s.claimsScreened} screened / ${s.claimsContested} contested / ${s.claimsRefuted} refuted · ` +
    `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"} · ${(s.durationMs / 1000).toFixed(0)}s`
  );
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
        allowPositionals: true,
        options: {
          effort: { type: "string" },
          budget: { type: "string" },
          timeout: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          store: { type: "string" },
          resume: { type: "string" },
          trace: { type: "string" },
          out: { type: "string", short: "o" },
          json: { type: "boolean" },
          quiet: { type: "boolean", short: "q" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (err) {
      fail(messageOf(err));
    }
  })();
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const question = positionals.join(" ").trim();
  const resumeId = values.resume;
  if (!question && !resumeId) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (resumeId && !values.store) fail("--resume requires --store <dir>");

  const effort = parseEffort(values.effort);
  const traceMode = parseTrace(values.trace);
  const budget: Budget = {};
  const maxUSD = parsePositiveNumber(values.budget, "--budget");
  if (maxUSD !== undefined) budget.maxUSD = maxUSD;
  const timeoutSeconds = parsePositiveNumber(values.timeout, "--timeout");
  if (timeoutSeconds !== undefined) {
    budget.maxDurationMs = Math.floor(timeoutSeconds * 1000);
  }

  const cheapModels = resolveCheapModels();
  const config: AtlasConfig = {
    model: resolveModel(values.provider, values.model),
    ...(cheapModels ? { models: cheapModels } : {}),
    ...(values.store ? { store: fileStore(values.store) } : {}),
    ...(traceMode && traceMode !== "off" ? { trace: traceMode } : {}),
  };

  const atlas = new Atlas(config);
  let run: ResearchRun;
  try {
    run = resumeId
      ? await atlas.resume(resumeId)
      : atlas.start(question, {
          ...(effort ? { effort } : {}),
          ...(Object.keys(budget).length > 0 ? { budget } : {}),
        });
  } catch (err) {
    fail(messageOf(err));
  }

  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts > 1) process.exit(130);
    if (values.store) {
      process.stderr.write(
        `\natlas: parking run — resume with --resume ${run.id} --store ${values.store}\n`,
      );
      void run.pause();
    } else {
      process.stderr.write("\natlas: cancelling — Ctrl-C again to force quit\n");
      void run.cancel();
    }
  };
  process.on("SIGINT", onSigint);

  const streamReport = !values.json && !values.out;
  let streamed = "";
  try {
    for await (const event of run.events()) {
      if (event.type === "report.delta") {
        if (streamReport) {
          process.stdout.write(event.text);
          streamed += event.text;
        }
        continue;
      }
      if (event.type === "report.reset") {
        if (streamReport && streamed) {
          process.stdout.write("\n");
          process.stderr.write("atlas: draft restarted\n");
          streamed = "";
        }
        continue;
      }
      if (event.type === "report.completed") continue;
      if (values.quiet) continue;
      const line = formatEvent(event);
      if (line) process.stderr.write(line + "\n");
    }
    const result = await run.result();
    if (traceMode && traceMode !== "off") {
      writeTrace(
        run,
        question,
        effort ?? "balanced",
        result.stats,
        values.quiet === true,
      );
    }
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (values.out) {
      writeFileSync(values.out, result.report);
      if (!values.quiet) process.stderr.write(`wrote ${values.out}\n`);
    } else if (collapse(streamed) !== collapse(result.report)) {
      if (streamed) {
        process.stdout.write("\n\n");
        process.stderr.write(
          "atlas: report revised during citation binding — final version follows\n",
        );
      }
      process.stdout.write(
        result.report.endsWith("\n") ? result.report : result.report + "\n",
      );
    } else {
      process.stdout.write("\n");
    }
    if (!values.quiet) process.stderr.write(footer(result) + "\n");
  } catch (err) {
    if (run.status() === "paused") {
      process.stderr.write(`atlas: ${messageOf(err)}\n`);
      process.exit(130);
    }
    if (run.status() === "cancelled") process.exit(130);
    fail(messageOf(err));
  } finally {
    process.off("SIGINT", onSigint);
  }
}

main();
