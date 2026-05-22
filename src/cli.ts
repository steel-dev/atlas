#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  RESEARCH_DEPTHS,
  research,
  type Engine,
  type ResearchDepth,
  type ResearchEvent,
} from "./research.js";

const USAGE = `atlas — deep research from your terminal

Usage:
  atlas "<question>" [options]

A gather agent searches and fetches sources, then a single writer composes the
cited report from all sources.

Options:
  -o, --out <file>            Write the markdown report to <file> (default: stdout)
      --max-sources N         Cap on cited sources (default 24)
      --max-tool-calls N      Gather-agent tool-call cap (default 48)
      --depth <d>             Budget preset: fast | standard | deep (default standard)
      --timeout N             Overall wall-clock budget in seconds (default: none)
      --engine <e>            Default web SERP: ddg | bing | google (default ddg)
      --use-proxy             Route Steel through residential proxy
      --fast-model <m>        Override gather model id
      --writer-model <m>      Override Sonnet writer model id
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
  atlas "..." --out report.md --max-sources 20 --engine google
  atlas "..." --json 2> events.jsonl > report.md
`;

const VERSION = "0.1.0";

const ENGINES: Engine[] = ["ddg", "bing", "google"];
const DEPTHS: ResearchDepth[] = [...RESEARCH_DEPTHS];

function fail(message: string, code = 1): never {
  process.stderr.write(`atlas: ${message}\n`);
  process.exit(code);
}

function readEnv(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function parseNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${name} must be a number (got "${raw}")`);
  return n;
}

function isEngine(s: string): s is Engine {
  return (ENGINES as string[]).includes(s);
}

function isDepth(s: string): s is ResearchDepth {
  return (DEPTHS as string[]).includes(s);
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
          "max-sources": { type: "string" },
          "max-tool-calls": { type: "string" },
          depth: { type: "string" },
          timeout: { type: "string" },
          engine: { type: "string" },
          "use-proxy": { type: "boolean" },
          "fast-model": { type: "string" },
          "writer-model": { type: "string" },
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

  const anthropicApiKey = readEnv(
    "ATLAS_ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY",
  );
  const steelApiKey = readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY");
  const steelBaseUrl = readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL");

  if (!anthropicApiKey) {
    fail("ANTHROPIC_API_KEY (or ATLAS_ANTHROPIC_API_KEY) is not set");
  }
  if (!steelApiKey) {
    fail("STEEL_API_KEY (or ATLAS_STEEL_API_KEY) is not set");
  }

  const engine = values.engine;
  if (engine !== undefined && !isEngine(engine)) {
    fail(`--engine must be one of ${ENGINES.join(", ")} (got "${engine}")`);
  }

  const depth = values.depth;
  if (depth !== undefined && !isDepth(depth)) {
    fail(`--depth must be one of ${DEPTHS.join(", ")} (got "${depth}")`);
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
      anthropicApiKey,
      steelApiKey,
      steelBaseUrl,
      maxSources: parseNumber(values["max-sources"], "--max-sources"),
      maxToolCalls: parseNumber(values["max-tool-calls"], "--max-tool-calls"),
      depth: depth as ResearchDepth | undefined,
      engine: engine as Engine | undefined,
      useProxy: values["use-proxy"] === true,
      fastModel: values["fast-model"],
      writerModel: values["writer-model"],
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
