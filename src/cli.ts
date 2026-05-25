#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { research, type ResearchEvent, type WriterEffort } from "./research.js";

const USAGE = `atlas — deep research from your terminal

Usage:
  atlas "<question>" [options]

A gather agent searches and fetches sources, then a single writer composes the
cited report from all sources.

Options:
  -o, --out <file>            Write the markdown report to <file> (default: stdout)
      --budget-usd N          Per-run dollar budget hint (actual caps are provider-enforced)
      --timeout N             Overall wall-clock budget in seconds (default: none)
      --effort LEVEL          Writer effort: low, medium, high, max (default: high)
      --json                  Emit one JSON event per line on stderr
  -q, --quiet                 Suppress progress events on stderr
  -h, --help                  Show this help
  -v, --version               Show version

Environment:
  ATLAS_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY   required
  ATLAS_STEEL_API_KEY      or STEEL_API_KEY       required
  ATLAS_STEEL_BASE_URL     or STEEL_BASE_URL      optional (self-hosted Steel)

Examples:
  atlas "What changed when Cloudflare DO added SQLite?"
  atlas "..." --out report.md
  atlas "..." --budget-usd 5 --effort max
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

const WRITER_EFFORTS = new Set<WriterEffort>(["low", "medium", "high", "max"]);

function parseEffort(raw: string | undefined): WriterEffort | undefined {
  if (raw === undefined) return undefined;
  if (WRITER_EFFORTS.has(raw as WriterEffort)) return raw as WriterEffort;
  fail(`--effort must be one of: low, medium, high, max (got "${raw}")`);
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";

function colored(): boolean {
  return !process.env.NO_COLOR && process.stderr.isTTY === true;
}

function paint(color: string, text: string): string {
  return colored() ? `${color}${text}${RESET}` : text;
}

function prettyEvent(e: ResearchEvent): string {
  switch (e.type) {
    case "agent_started":
      return paint(DIM, "  →") + " agent started";
    case "agent_finished":
      return (
        paint(DIM, "  ✓") +
        ` agent done — ${e.sources_added} source${e.sources_added === 1 ? "" : "s"}`
      );
    case "searching":
      return paint(DIM, `    search:`) + ` ${e.query}`;
    case "search_results":
      return paint(DIM, `      ↳ ${e.count} result${e.count === 1 ? "" : "s"}`);
    case "search_failed":
      return paint(YELLOW, `    ! search failed:`) + ` ${e.error}`;
    case "fetching":
      return paint(DIM, `    fetch: ${e.url}`);
    case "inspecting":
      return paint(DIM, `    inspect: ${e.url}`);
    case "steel_fallback":
      return paint(DIM, `      browser fallback: ${e.url} — ${e.reason}`);
    case "rate_limited":
      return (
        paint(YELLOW, "    ! rate limited:") +
        ` waiting ${e.retry_after_seconds}s (retry ${e.attempt}/${e.max_attempts - 1})`
      );
    case "source_committed":
      return paint(GREEN, `    ✓`) + ` [${e.n}] ${e.url}`;
    case "source_error":
      return paint(YELLOW, `    ! ${e.url} — ${e.error}`);
    case "writing":
      return (
        paint(BLUE, "→") +
        ` writing report (${e.sources_count} source${e.sources_count === 1 ? "" : "s"})`
      );
    case "written":
      return (
        paint(GREEN, "✓") + ` written (${e.markdown_chars.toLocaleString()} chars)`
      );
    case "completed": {
      const us = e.result.usage_summary;
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
        ` done — ${e.result.sources.length} sources\n` +
        tokenLine
      );
    }
  }
}

async function main(): Promise<void> {
  const parsed = (() => {
    try {
      return parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
          out: { type: "string", short: "o" },
          "budget-usd": { type: "string" },
          timeout: { type: "string" },
          effort: { type: "string" },
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
  const budgetUsd = parseNumber(values["budget-usd"], "--budget-usd");
  if (budgetUsd !== undefined && budgetUsd <= 0) {
    fail(`--budget-usd must be > 0 (got ${budgetUsd})`);
  }
  const effort = parseEffort(values.effort);
  const signal =
    timeoutSeconds !== undefined
      ? AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(Math.floor(timeoutSeconds * 1000)),
        ])
      : controller.signal;

  const json = values.json === true;
  const quiet = values.quiet === true;

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
      budgetUsd,
      effort,
      onEvent,
      signal,
    });

    if (values.out) {
      writeFileSync(values.out, result.markdown);
      if (!quiet) {
        process.stderr.write(
          prettyEvent({ type: "completed", result }) + "\n",
        );
        process.stderr.write(`  ↳ wrote ${values.out}\n`);
      }
    } else {
      process.stdout.write(result.markdown);
      if (!result.markdown.endsWith("\n")) process.stdout.write("\n");
      if (!quiet) {
        process.stderr.write(
          prettyEvent({ type: "completed", result }) + "\n",
        );
      }
    }
  } catch (err) {
    // SDK abort errors don't preserve the original DOMException, so inspect
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
