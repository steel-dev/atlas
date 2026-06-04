---
name: atlas-research
description:
  Run the local atlas CLI to produce a cited deep-research markdown report.
  Use when the user explicitly invokes atlas — e.g., `/atlas-research <question>`, "run atlas on
  X", "use atlas to research Y". Returns the markdown to the conversation along with the
  run summary. Do NOT use for casual questions Claude can answer from training/web —
  this spends the user's model-provider + Steel credits and takes 1–4 minutes.
user-invocable: true
allowed-tools: Bash, Read
---

# atlas-research

Run a deep-research query via this repo's atlas CLI and return the cited markdown report.

Atlas runs a fixed research lifecycle: it scopes the question into search angles, fetches sources through
Steel, extracts verbatim-quoted claims, chases gaps with a lead agent, adversarially verifies every claim
with independent voters, and synthesizes a cited Markdown report from the claims that survive. The harness
provides web/search/browser tools, runtime limits, caching, and progress events.

## Step 1 — Get the question

If the user's invocation includes text after `/atlas-research`, that's the question — use it
verbatim.

If the invocation is empty, output this usage line and stop:

> Usage: `/atlas-research <your question>`
>
> Example: `/atlas-research What changed when Cloudflare Durable Objects added SQLite?`

## Step 2 — Verify keys are in the shell env

```bash
if { [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$ATLAS_ANTHROPIC_API_KEY" ] || \
     [ -n "$OPENAI_API_KEY" ] || [ -n "$ATLAS_OPENAI_API_KEY" ]; } && \
   { [ -n "$STEEL_API_KEY" ] || [ -n "$ATLAS_STEEL_API_KEY" ]; }; then
  echo ok
else
  echo missing
fi
```

If `missing`, stop and tell the user:

> Atlas needs Steel plus one model-provider API key set in your shell:
>
> ```
> export ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com
> # or:
> export ATLAS_PROVIDER=openai
> export OPENAI_API_KEY=sk-...          # https://platform.openai.com
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

**Defaults are fine.** Only add flags that the current CLI supports and the user clearly asked for:

| Hint                         | Append flag(s)              |
| ---------------------------- | --------------------------- |
| "go deeper" / "be thorough"  | `--token-limit 5000000`     |
| "be quick" / "fast"          | `--token-limit 500000`      |
| explicit time limit          | `--timeout <seconds>`       |

If atlas exits non-zero, the user-facing message is the last `atlas: ...` line in `$ATLAS_LOG`.
Show that and stop — don't retry blindly.

## Step 5 — Return the report

```bash
tail -5 "$ATLAS_LOG"   # includes the ✓ done — N documents line, token usage, and wrote path
```

Then Read `$REPORT` and present it to the user as:

> **Atlas summary:** <the ✓ done line, and token usage line if present, stripped of ANSI color codes>
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
- One atlas job at a time — they share model-provider / Steel rate limits.
- Never log or echo API keys back to chat.
- Don't claim verification or citation-support stats; the current CLI reports opened/cited
  documents and token usage, not claim-level verification.
