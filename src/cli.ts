#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { research, type Engine, type ResearchEvent } from "./research.js";

const USAGE = `atlas — deep research from your terminal

Usage:
  atlas "<question>" [options]

A research-lead agent (Sonnet) decomposes your question and dispatches parallel
scout sub-agents (Haiku) with search + fetch tools. After the lead finalizes,
a single writer composes the report from all sources, and a verifier checks
every citation against the raw page.

Options:
  -o, --out <file>            Write the markdown report to <file> (default: stdout)
      --max-sources N         Cap on cited sources (default 12)
      --max-lead-turns N      Cap on lead-agent turns (default 8)
      --max-tool-calls N      Per-sub-agent tool-call cap (default 12)
      --engine <e>            Default web SERP: ddg | bing | google (default ddg)
      --use-proxy             Route Steel through residential proxy
      --fast-model <m>        Override Haiku (scout / summarize / verify) model id
      --writer-model <m>      Override Sonnet writer model id
      --lead-model <m>        Override lead-agent model id (defaults to writer model)
      --json                  Emit one JSON event per line on stderr
  -q, --quiet                 Suppress progress events on stderr
  -h, --help                  Show this help
  -v, --version               Show version

Environment:
  ATLAS_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY   required
  ATLAS_STEEL_API_KEY      or STEEL_API_KEY       required
  ATLAS_STEEL_BASE_URL     or STEEL_BASE_URL      optional (self-hosted Steel)
  ATLAS_GITHUB_TOKEN       or GITHUB_TOKEN        optional (raises github
                                                  search rate limits)

Examples:
  atlas "What changed when Cloudflare DO added SQLite?"
  atlas "..." --out report.md --max-sources 20 --engine google
  atlas "..." --json 2> events.jsonl > report.md
`;

const VERSION = "0.1.0";

const ENGINES: Engine[] = ["ddg", "bing", "google"];

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

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";

function colored(): boolean {
  return !process.env.NO_COLOR && process.stderr.isTTY === true;
}

function paint(color: string, text: string): string {
  return colored() ? `${color}${text}${RESET}` : text;
}

function prettyEvent(e: ResearchEvent): string {
  const tag = (subQ: string) => {
    if (!subQ) return "";
    const t = subQ.length > 24 ? subQ.slice(0, 22) + "…" : subQ;
    return paint(DIM, ` [${t}]`);
  };
  switch (e.type) {
    case "lead_started":
      return paint(BLUE, "→") + ` lead planning: ${e.query}`;
    case "lead_turn":
      return (
        paint(DIM, `  turn ${e.turn}: `) +
        `spawning ${e.spawned} scout${e.spawned === 1 ? "" : "s"}`
      );
    case "subagent_spawned":
      return paint(BLUE, "  ↳") + ` scout: ${e.sub_question}`;
    case "lead_finalize":
      return (
        paint(GREEN, "✓") +
        ` lead finalized — ${e.sources_count} source${e.sources_count === 1 ? "" : "s"} gathered` +
        (e.notes ? "\n" + paint(DIM, `  notes: ${e.notes}`) : "")
      );
    case "agent_started":
      return paint(DIM, "  →") + ` agent started${tag(e.sub_question)}`;
    case "agent_finished":
      return (
        paint(DIM, "  ✓") +
        ` agent done${tag(e.sub_question)} — ${e.sources_added} source${e.sources_added === 1 ? "" : "s"}`
      );
    case "searching":
      return paint(DIM, `    search:`) + tag(e.sub_question) + ` ${e.query}`;
    case "search_results":
      return paint(DIM, `      ↳ ${e.count} result${e.count === 1 ? "" : "s"}`);
    case "search_failed":
      return (
        paint(YELLOW, `    ! search failed:`) + tag(e.sub_question) + ` ${e.error}`
      );
    case "fetching":
      return paint(DIM, `    fetch: ${e.url}`) + tag(e.sub_question);
    case "summarized":
      return paint(GREEN, `    ✓`) + ` [${e.n}] ${e.url}` + tag(e.sub_question);
    case "source_skipped":
      return paint(DIM, `    · skipped ${e.url} (${e.reason})`);
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
    case "verifying":
      return (
        paint(BLUE, "→") +
        ` verifying ${e.total} claim${e.total === 1 ? "" : "s"}`
      );
    case "verified_claim": {
      const mark = e.supported ? paint(GREEN, "  ✓") : paint(RED, "  ✗");
      const ref = `[${e.source_n}]`;
      return `${mark} ${ref} ${paint(DIM, `(${e.done}/${e.total})`)} ${e.supported ? "" : paint(DIM, e.reason)}`;
    }
    case "completed": {
      const vs = e.result.verification_summary;
      const us = e.result.usage_summary;
      const tail =
        vs.total > 0
          ? `${vs.supported}/${vs.total} claims supported (${(vs.pass_rate * 100).toFixed(0)}%)`
          : "no claims to verify";
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
        ` done — ${e.result.sources.length} sources, ${tail}\n` +
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
          "max-lead-turns": { type: "string" },
          "max-tool-calls": { type: "string" },
          engine: { type: "string" },
          "use-proxy": { type: "boolean" },
          "fast-model": { type: "string" },
          "writer-model": { type: "string" },
          "lead-model": { type: "string" },
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
  const githubToken = readEnv("ATLAS_GITHUB_TOKEN", "GITHUB_TOKEN");

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

  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write("\natlas: cancelling…\n");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

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
      maxLeadTurns: parseNumber(values["max-lead-turns"], "--max-lead-turns"),
      maxToolCalls: parseNumber(values["max-tool-calls"], "--max-tool-calls"),
      engine: engine as Engine | undefined,
      useProxy: values["use-proxy"] === true,
      fastModel: values["fast-model"],
      writerModel: values["writer-model"],
      leadModel: values["lead-model"],
      githubToken,
      onEvent,
      signal: controller.signal,
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
    if ((err as { name?: string })?.name === "AbortError") {
      process.exit(130);
    }
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
}

main();
