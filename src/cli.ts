#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  research,
  type ModelProvider,
  type ResearchEffort,
  type ResearchEvent,
} from "./research.js";

const USAGE = `atlas — deep research from your terminal

Usage:
  atlas "<question>" [options]

A research loop searches, fetches sources, and writes a cited Markdown report.

Options:
  -o, --out <file>            Write the markdown report to <file> (default: stdout)
      --timeout N             Overall wall-clock budget in seconds (default: none)
      --effort LEVEL          Reasoning + exploration budget: low, medium, high, max (default: high)
      --provider PROVIDER     Model provider: anthropic, openai (default: auto)
      --model MODEL           Model name (default: provider-specific)
      --summary-model MODEL   Cheap model for per-source summaries (default: haiku on anthropic)
      --base-url URL          OpenAI-compatible base URL (provider=openai)
      --proxy                 Route Steel search and fetch requests through proxy
      --json                  Emit one JSON event per line on stderr
  -q, --quiet                 Suppress progress events on stderr
  -h, --help                  Show this help
  -v, --version               Show version

Environment:
  ATLAS_PROVIDER                                optional (anthropic, openai)
  ATLAS_MODEL                                   optional
  ATLAS_SUMMARY_MODEL                           optional (per-source summary model)
  ATLAS_MAX_DELEGATION_DEPTH                    optional (0 disables sub-agent delegation)
  ATLAS_MAX_SUBAGENTS                           optional (max concurrent sub-agents)
  ATLAS_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY  required for provider=anthropic
  ATLAS_OPENAI_API_KEY    or OPENAI_API_KEY     required for provider=openai
  ATLAS_OPENAI_BASE_URL   or OPENAI_BASE_URL    optional (OpenAI-compatible)
  ATLAS_STEEL_API_KEY      or STEEL_API_KEY       required
  ATLAS_STEEL_BASE_URL     or STEEL_BASE_URL      optional (self-hosted Steel)

Examples:
  atlas "What changed when Cloudflare DO added SQLite?"
  atlas "..." --out report.md
  atlas "..." --effort max
  atlas "..." --provider openai --model gpt-4.1
  atlas "..." --proxy
  atlas "..." --timeout 300
  atlas "..." --json 2> events.jsonl > report.md
`;

const VERSION = "0.1.0";

function fail(message: string, code = 1): never {
  process.stderr.write(`atlas: ${message}\n`);
  process.exit(code);
}

function parseNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${name} must be a number (got "${raw}")`);
  return n;
}

const RESEARCH_EFFORTS = new Set<ResearchEffort>(["low", "medium", "high", "max"]);
const MODEL_PROVIDERS = new Set<ModelProvider>(["anthropic", "openai"]);

function parseEffort(raw: string | undefined): ResearchEffort | undefined {
  if (raw === undefined) return undefined;
  if (RESEARCH_EFFORTS.has(raw as ResearchEffort)) return raw as ResearchEffort;
  fail(`--effort must be one of: low, medium, high, max (got "${raw}")`);
}

function parseProvider(raw: string | undefined): ModelProvider | undefined {
  if (raw === undefined) return undefined;
  if (MODEL_PROVIDERS.has(raw as ModelProvider)) return raw as ModelProvider;
  fail(`--provider must be one of: anthropic, openai (got "${raw}")`);
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function colored(): boolean {
  return !process.env.NO_COLOR && process.stderr.isTTY === true;
}

function paint(color: string, text: string): string {
  return colored() ? `${color}${text}${RESET}` : text;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function prettyEvent(e: ResearchEvent): string {
  const pad = "  ".repeat(Math.max(0, e.depth ?? 0));
  return pad + prettyEventBody(e);
}

function prettyEventBody(e: ResearchEvent): string {
  switch (e.type) {
    case "research_started":
      return paint(DIM, "  →") + " research started";
    case "research_finished":
      return (
        paint(DIM, "  ✓") +
        ` research done — ${e.sourcesFetched} source${e.sourcesFetched === 1 ? "" : "s"} fetched`
      );
    case "delegation_started":
      return (
        paint(DIM, "    ⇣") +
        ` delegating ${e.tasks.length} sub-agent${e.tasks.length === 1 ? "" : "s"}`
      );
    case "subagent_started":
      return paint(DIM, "      ↳ sub-agent:") + ` ${truncate(e.task, 80)}`;
    case "subagent_finished":
      return (
        paint(GREEN, "      ✓ sub-agent:") +
        ` ${truncate(e.task, 64)}` +
        paint(
          DIM,
          ` (${e.sourcesFetched} source${e.sourcesFetched === 1 ? "" : "s"}, ${e.toolCalls} call${e.toolCalls === 1 ? "" : "s"})`,
        )
      );
    case "searching":
      return paint(DIM, `    search:`) + ` ${e.query}`;
    case "search_results":
      return paint(DIM, `      ↳ ${e.count} result${e.count === 1 ? "" : "s"}`);
    case "search_failed":
      return paint(YELLOW, `    ! search failed:`) + ` ${e.error}`;
    case "fetching":
      return paint(DIM, `    fetch: ${e.url}`);
    case "rate_limited":
      return (
        paint(YELLOW, "    ! rate limited:") +
        ` waiting ${e.retryAfterSeconds}s (retry ${e.attempt}/${e.maxAttempts - 1})`
      );
    case "source_fetched":
      return (
        paint(GREEN, `    ✓`) +
        ` ${e.url}` +
        (e.method ? paint(DIM, ` (${e.method}`) : "") +
        (e.markdownChars !== undefined
          ? paint(DIM, `${e.method ? ", " : " ("}${e.markdownChars.toLocaleString()} chars`)
          : "") +
        (e.method || e.markdownChars !== undefined ? paint(DIM, ")") : "")
      );
    case "source_error":
      return paint(YELLOW, `    ! ${e.url} — ${e.error}`);
    case "unverified_citations":
      return (
        paint(YELLOW, "    ! unverified citations:") +
        ` ${e.count} URL${e.count === 1 ? "" : "s"} not fetched by Atlas`
      );
    case "written":
      return (
        paint(GREEN, "✓") + ` written (${e.markdownChars.toLocaleString()} chars)`
      );
    case "completed": {
      const us = e.result.usage;
      const totalInput =
        us.input_tokens +
        us.cache_creation_input_tokens +
        us.cache_read_input_tokens;
      const cacheHitPct =
        totalInput > 0
          ? (us.cache_read_input_tokens / totalInput) * 100
          : 0;
      const tokenLine = paint(
        DIM,
        `  ↳ ${totalInput.toLocaleString()} in / ${us.output_tokens.toLocaleString()} out tok · cache ${cacheHitPct.toFixed(0)}% hit (${us.cache_read_input_tokens.toLocaleString()} read, ${us.cache_creation_input_tokens.toLocaleString()} write)`,
      );
      return (
        paint(GREEN, "✓") +
        ` done — ${e.result.verifiedSources.length} documents\n` +
        tokenLine
      );
    }
  }
}

function writeCompletionSummary(result: Awaited<ReturnType<typeof research>>, json: boolean): void {
  if (json) {
    process.stderr.write(JSON.stringify({ type: "completed", result }) + "\n");
    return;
  }
  process.stderr.write(prettyEvent({ type: "completed", result }) + "\n");
}

async function main(): Promise<void> {
  const parsed = (() => {
    try {
      return parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
          out: { type: "string", short: "o" },
          timeout: { type: "string" },
          effort: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          "summary-model": { type: "string" },
          "base-url": { type: "string" },
          proxy: { type: "boolean" },
          json: { type: "boolean" },
          quiet: { type: "boolean", short: "q" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean", short: "v" },
        },
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  })();
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const query = positionals.join(" ").trim();
  if (!query) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write("\natlas: cancelling…\n");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  const timeoutSeconds = parseNumber(values.timeout, "--timeout");
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
    fail(`--timeout must be > 0 (got ${timeoutSeconds})`);
  }
  const effort = parseEffort(values.effort);
  const provider = parseProvider(values.provider);
  const signal =
    timeoutSeconds !== undefined
      ? AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(Math.floor(timeoutSeconds * 1000)),
        ])
      : controller.signal;

  const json = values.json === true;
  const quiet = values.quiet === true;
  const useProxy = values.proxy === true;

  const onEvent = quiet
    ? undefined
    : (e: ResearchEvent) => {
        if (e.type === "completed") {
          // skip — terminal summary will be written after the markdown is emitted
          return;
        }
        if (json) {
          process.stderr.write(JSON.stringify(e) + "\n");
        } else {
          process.stderr.write(prettyEvent(e) + "\n");
        }
      };

  try {
    const result = await research({
      query,
      provider,
      model: values.model,
      summaryModel: values["summary-model"],
      openaiBaseUrl: values["base-url"],
      effort,
      useProxy,
      onEvent,
      signal,
    });

    if (values.out) {
      writeFileSync(values.out, result.markdown);
      if (!quiet) {
        writeCompletionSummary(result, json);
        process.stderr.write(`  ↳ wrote ${values.out}\n`);
      }
    } else {
      process.stdout.write(result.markdown);
      if (!result.markdown.endsWith("\n")) process.stdout.write("\n");
      if (!quiet) {
        writeCompletionSummary(result, json);
      }
    }
  } catch (err) {
    // SDK abort errors don't preserve the original DOMException, so check
    // the signal directly to distinguish timeout vs SIGINT vs API error.
    if (signal.aborted) {
      const reason = signal.reason as { name?: string } | undefined;
      if (reason?.name === "TimeoutError") {
        process.stderr.write(
          `atlas: timed out after ${timeoutSeconds}s (--timeout)\n`,
        );
        process.exit(124);
      }
      process.exit(130);
    }
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
}

main();
