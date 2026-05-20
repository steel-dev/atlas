---
name: atlas-research
description:
  Run the local atlas CLI to produce a cited, verified deep-research markdown report.
  Use when the user explicitly invokes atlas — e.g., `/atlas-research <question>`, "run atlas on
  X", "use atlas to research Y". Returns the markdown to the conversation along with the
  verification summary. Do NOT use for casual questions Claude can answer from training/web —
  this spends the user's Anthropic + Steel credits and takes 1–4 minutes.
user-invocable: true
allowed-tools: Bash, Read
---

# atlas-research

Run a deep-research query via this repo's atlas CLI and return the cited markdown report.

The pipeline (handled by the CLI): plan brief + sub-questions → search → fetch + per-page
summarize → assess coverage (loops if gaps remain) → write report (Sonnet) → verify every `[n]`
citation (Haiku). If verification falls below the threshold, exactly one rewrite is attempted.

## Step 1 — Get the question

If the user's invocation includes text after `/atlas-research`, that's the question — use it
verbatim.

If the invocation is empty, output this usage line and stop:

> Usage: `/atlas-research <your question>`
>
> Example: `/atlas-research What changed when Cloudflare Durable Objects added SQLite?`

## Step 2 — Verify keys are in the shell env

```bash
if { [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$ATLAS_ANTHROPIC_API_KEY" ]; } && \
   { [ -n "$STEEL_API_KEY" ] || [ -n "$ATLAS_STEEL_API_KEY" ]; }; then
  echo ok
else
  echo missing
fi
```

If `missing`, stop and tell the user:

> Atlas needs two env vars set in your shell:
>
> ```
> export ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com
> export STEEL_API_KEY=sk_...           # https://app.steel.dev
> ```
>
> Restart this Claude Code session after exporting them, then re-run `/atlas-research`.

**Never** ask the user to paste API keys into the chat — keys do not belong in transcripts. The
env-var path is the only supported way.

## Step 3 — Confirm we're in the atlas repo

```bash
test -f src/cli.ts && test -f package.json && echo ok || echo not-atlas
```

If `not-atlas`, tell the user to `cd` into the atlas repo and re-run. Don't try to install or
locate it.

## Step 4 — Run atlas

Use `tsx` so no build step is required. Capture stderr to a log file and write the markdown to a
temp file via `--out`:

```bash
REPORT=$(mktemp -t atlas-XXXXXX).md
ATLAS_LOG=$(mktemp -t atlas-events-XXXXXX).log
npx tsx src/cli.ts '<QUESTION>' [extra flags] --out "$REPORT" 2> "$ATLAS_LOG"
echo "REPORT=$REPORT"
echo "LOG=$ATLAS_LOG"
```

Bash tool `timeout`: `600000` (10 min — the max). Typical runs land in 1–4 min.

**Quoting**: wrap `<QUESTION>` in single quotes. If the question itself contains a single quote,
escape it with the `'\''` dance: `it'\''s great`.

**Defaults are fine** (12 sources, 2 hops, threshold 0.7). Only add flags if the user's wording
signals intent:

| Hint                                  | Append flag(s)                         |
| ------------------------------------- | -------------------------------------- |
| "use google" / "via bing"             | `--engine google` / `--engine bing`    |
| "go deeper" / "be thorough"           | `--max-sources 20 --max-hops 3`        |
| "be quick" / "fast"                   | `--max-sources 4 --max-hops 0`         |
| "strict citations"                    | `--verify-threshold 0.85`              |
| "use proxy" / "anti-bot site"         | `--use-proxy`                          |

If atlas exits non-zero, the user-facing message is the last `atlas: ...` line in `$ATLAS_LOG`.
Show that and stop — don't retry blindly.

## Step 5 — Return the report

```bash
tail -1 "$ATLAS_LOG"   # the ✓ done — N sources, X/Y claims supported (Z%) summary
```

Then Read `$REPORT` and present it to the user as:

> **Atlas summary:** <the ✓ done line, stripped of ANSI color codes>
>
> <the full markdown report verbatim>

If the report is very long (>20k chars), still include it fully — the user asked for it. Don't
truncate.

Clean up afterward:

```bash
rm -f "$REPORT" "$ATLAS_LOG"
```

## Boundaries

- Only runs from the atlas repo root (where `src/cli.ts` lives).
- One atlas job at a time — they share Anthropic / Steel rate limits.
- Never log or echo API keys back to chat.
- Don't claim verification stats you didn't read from `$ATLAS_LOG` — the numbers come from atlas,
  not from you.
