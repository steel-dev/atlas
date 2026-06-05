#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type ModelProvider,
  type ResearchEvent,
  type ResearchResult,
  type ResearchStream,
} from "./research.js";
import { Atlas } from "./atlas.js";
import { resolveModelSpec } from "./config-resolution.js";
import { steel } from "./steel.js";
import { exa, brave, type SearchProvider } from "./search-provider.js";

const USAGE = `atlas — deep research from your terminal

Usage:
  atlas "<question>" [options]

A research lifecycle scopes the question, searches it from several angles,
extracts verbatim-quoted claims, chases gaps, adversarially verifies every
claim, and synthesizes a cited Markdown report from the survivors.

Options:
  -o, --out <file>            Write the markdown report to <file> (default: stdout)
      --timeout N             Overall wall-clock budget in seconds (default: none)
      --token-limit N         Total token budget for the run (default: 2000000; 0 = unlimited)
      --provider PROVIDER     Model provider: anthropic, openai (default: auto)
      --search-provider NAME  Search backend: web, exa, brave (default: web)
      --model MODEL           Model name (default: provider-specific)
      --leaf-model MODEL      Model for claim extraction and verification voters (default: the main model)
      --proxy                 Route Steel search and fetch requests through proxy
      --json                  Emit one JSON event per line on stderr
  -q, --quiet                 Suppress progress events on stderr
  -h, --help                  Show this help
  -v, --version               Show version

Environment:
  ATLAS_PROVIDER                                optional (anthropic, openai)
  ATLAS_EXA_API_KEY       or EXA_API_KEY        required for --search-provider exa
  ATLAS_BRAVE_API_KEY     or BRAVE_API_KEY      required for --search-provider brave
  ATLAS_MODEL                                   optional
  ATLAS_LEAF_MODEL                              optional (claim extraction + verifier model)
  ATLAS_TOKEN_LIMIT                             optional (total token budget; 0 = unlimited)
  ATLAS_MAX_CONCURRENT_MODEL_CALLS              optional (leaf fan-out width, default 8)
  ATLAS_REANCHOR_TOKENS                         optional (lead re-anchor threshold; default 200000)
  ATLAS_BROWSER_IDLE_TTL_MS                     optional (default 120000; <=0 disables)
  ATLAS_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY  required for provider=anthropic
  ATLAS_OPENAI_API_KEY    or OPENAI_API_KEY     required for provider=openai
  ATLAS_STEEL_API_KEY      or STEEL_API_KEY       required
  ATLAS_STEEL_BASE_URL     or STEEL_BASE_URL      optional (self-hosted Steel)

Examples:
  atlas "What changed when Cloudflare DO added SQLite?"
  atlas "..." --out report.md
  atlas "..." --token-limit 5000000
  atlas "..." --provider openai --model gpt-5.5
  atlas "..." --proxy
  atlas "..." --timeout 300
  atlas "..." --json 2> events.jsonl > report.md
`;

const VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

function fail(message: string, code = 1): never {
  process.stderr.write(`atlas: ${message}\n`);
  process.exit(code);
}

function parseNumber(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${name} must be a number (got "${raw}")`);
  return n;
}

const MODEL_PROVIDERS = new Set<ModelProvider>(["anthropic", "openai"]);

function parseTokenLimit(raw: string | undefined): number | undefined {
  const n = parseNumber(raw, "--token-limit");
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 0) {
    fail(`--token-limit must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

function parseProvider(raw: string | undefined): ModelProvider | undefined {
  if (raw === undefined) return undefined;
  if (MODEL_PROVIDERS.has(raw as ModelProvider)) return raw as ModelProvider;
  fail(`--provider must be one of: anthropic, openai (got "${raw}")`);
}

function resolveSearch(raw: string | undefined): SearchProvider | undefined {
  const kind = (raw ?? "").trim().toLowerCase();
  if (!kind || kind === "web") return undefined;
  if (kind === "exa") return exa();
  if (kind === "brave") return brave();
  fail(`--search-provider must be one of: web, exa, brave (got "${raw}")`);
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
  return prettyEventBody(e);
}

function prettyEventBody(e: ResearchEvent): string {
  switch (e.type) {
    case "report_boundary":
    case "report_delta":
      return "";
    case "tool_event": {
      const detail =
        typeof e.data === "string"
          ? e.data
          : e.data === undefined
            ? ""
            : JSON.stringify(e.data);
      return (
        paint(DIM, `    ⚙ ${e.tool}`) +
        (detail ? ` ${truncate(detail, 80)}` : "")
      );
    }
    case "research_started":
      return paint(DIM, "  →") + " research started";
    case "scope_completed":
      return (
        paint(DIM, "  →") +
        ` scoped into ${e.angles.length} angle${e.angles.length === 1 ? "" : "s"}: ${e.angles.map((angle) => angle.label).join(", ")}`
      );
    case "research_finished":
      return (
        paint(DIM, "  ✓") +
        ` research done — ${e.sourcesFetched} source${e.sourcesFetched === 1 ? "" : "s"} fetched`
      );
    case "context_reanchored":
      return paint(
        DIM,
        `    ⤵ context re-anchored — dropped ${e.droppedMessages} message${e.droppedMessages === 1 ? "" : "s"} (~${Math.round(e.tokensBefore / 1000)}k tok)`,
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
          ? paint(
              DIM,
              `${e.method ? ", " : " ("}${e.markdownChars.toLocaleString()} chars`,
            )
          : "") +
        (e.method || e.markdownChars !== undefined ? paint(DIM, ")") : "")
      );
    case "source_error":
      return paint(YELLOW, `    ! ${e.url} — ${e.error}`);
    case "claims_extracted":
      return e.error
        ? paint(YELLOW, `      ! claims: ${e.url} — ${e.error}`)
        : paint(
            DIM,
            `      ↳ ${e.count} claim${e.count === 1 ? "" : "s"}${e.unsupported > 0 ? ` (${e.unsupported} unsupported)` : ""}`,
          );
    case "claims_clustered":
      return paint(
        DIM,
        `  → merged ${e.claimsDeduped} duplicate claim${e.claimsDeduped === 1 ? "" : "s"} into ${e.clustersFormed} cluster${e.clustersFormed === 1 ? "" : "s"}`,
      );
    case "verify_started":
      return (
        paint(DIM, "  →") +
        ` verifying ${e.claims} claim${e.claims === 1 ? "" : "s"}`
      );
    case "claim_verified":
      return (
        paint(e.status === "confirmed" ? GREEN : YELLOW, "    ✓") +
        ` ${truncate(e.claim, 64)} ` +
        paint(DIM, `(${e.vote} ${e.status})`)
      );
    case "verify_finished":
      return (
        paint(DIM, "  ✓") +
        ` verified — ${e.confirmed} confirmed, ${e.refuted} refuted` +
        (e.unverified > 0 ? `, ${e.unverified} unverified` : "")
      );
    case "citations_not_fetched":
      return (
        paint(YELLOW, "    ! citations not fetched:") +
        ` ${e.count} cited URL${e.count === 1 ? "" : "s"} Atlas did not read`
      );
    case "written":
      return (
        paint(GREEN, "✓") +
        ` written (${e.markdownChars.toLocaleString()} chars)`
      );
    case "completed": {
      const us = e.result.usage;
      const totalInput =
        us.input_tokens +
        us.cache_creation_input_tokens +
        us.cache_read_input_tokens;
      const cacheHitPct =
        totalInput > 0 ? (us.cache_read_input_tokens / totalInput) * 100 : 0;
      const tokenLine = paint(
        DIM,
        `  ↳ ${totalInput.toLocaleString()} in / ${us.output_tokens.toLocaleString()} out tok · cache ${cacheHitPct.toFixed(0)}% hit (${us.cache_read_input_tokens.toLocaleString()} read, ${us.cache_creation_input_tokens.toLocaleString()} write)`,
      );
      const notConfirmed = e.result.citationsNotConfirmed.length;
      return (
        paint(GREEN, "✓") +
        ` done — ${e.result.claims.confirmed.length} verified claim${e.result.claims.confirmed.length === 1 ? "" : "s"} from ${e.result.citedSources.length} cited source${e.result.citedSources.length === 1 ? "" : "s"}\n` +
        (notConfirmed > 0
          ? paint(
              YELLOW,
              `    ! ${notConfirmed} cited URL${notConfirmed === 1 ? "" : "s"} not backed by a confirmed claim`,
            ) + "\n"
          : "") +
        tokenLine
      );
    }
  }
}

function writeCompletionSummary(result: ResearchResult, json: boolean): void {
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
          "token-limit": { type: "string" },
          provider: { type: "string" },
          "search-provider": { type: "string" },
          model: { type: "string" },
          "leaf-model": { type: "string" },
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

  const timeoutSeconds = parseNumber(values.timeout, "--timeout");
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
    fail(`--timeout must be > 0 (got ${timeoutSeconds})`);
  }
  const tokenLimit = parseTokenLimit(values["token-limit"]);
  const provider = parseProvider(values.provider);

  const json = values.json === true;
  const quiet = values.quiet === true;
  const useProxy = values.proxy === true;

  let softStopRequested = false;
  let hardAborted = false;
  let timedOut = false;

  let run!: ResearchStream;
  try {
    const { model, leafModel } = await resolveModelSpec({
      provider,
      model: values.model,
      leafModel: values["leaf-model"],
    });
    const atlas = new Atlas({
      model,
      ...(leafModel ? { leafModel } : {}),
      search: resolveSearch(values["search-provider"]),
      ...(useProxy ? { browser: steel({ proxy: true }) } : {}),
    });
    run = atlas.stream(query, {
      tokenLimit,
      exploreProviderOptions: { anthropic: { thinking: { type: "adaptive" } } },
      finalizeProviderOptions: {
        anthropic: { thinking: { type: "adaptive" }, effort: "high" },
        openai: { reasoningEffort: "high" },
      },
      timeoutMs:
        timeoutSeconds !== undefined
          ? Math.floor(timeoutSeconds * 1000)
          : undefined,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const onSigint = () => {
    if (!softStopRequested) {
      softStopRequested = true;
      run.stop();
      process.stderr.write(
        "\natlas: finishing up with sources gathered so far — Ctrl-C again to force quit\n",
      );
      return;
    }
    process.stderr.write("\natlas: forcing quit…\n");
    hardAborted = true;
    run.abort();
  };
  const onSigterm = () => {
    process.stderr.write("\natlas: terminating…\n");
    hardAborted = true;
    run.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const timeoutTimer =
    timeoutSeconds !== undefined
      ? setTimeout(
          () => {
            timedOut = true;
          },
          Math.floor(timeoutSeconds * 1000),
        )
      : undefined;

  try {
    if (!quiet) {
      for await (const event of run.events) {
        if (event.type === "completed") continue;
        if (json) {
          process.stderr.write(JSON.stringify(event) + "\n");
        } else {
          process.stderr.write(prettyEvent(event) + "\n");
        }
      }
    }
    const result = await run.result;

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
    if (timedOut) {
      process.stderr.write(
        `atlas: timed out after ${timeoutSeconds}s (--timeout)\n`,
      );
      process.exit(124);
    }
    if (hardAborted) {
      process.exit(130);
    }
    if (softStopRequested) {
      process.stderr.write(
        "atlas: stopped before a report could be produced\n",
      );
      process.exit(130);
    }
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

main();
