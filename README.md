# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research from your terminal or your code.**

Ask a question, get back a cited markdown report. Powered by [Steel Browser](https://steel.dev) and [Anthropic Claude](https://www.anthropic.com/).

```bash
npx @steel-dev/atlas "What changed when Cloudflare Durable Objects added SQLite?"
```

```
→ turn 1: spawning 4 scouts
  → agent started [When did SQLite-backed...]
  → agent started [What new capabilities...]
  → agent started [What limits or trade-offs...]
  → agent started [How does it compare to KV...]
    search: [web] cloudflare durable objects sqlite release date
      ↳ 5 results
    fetch: https://blog.cloudflare.com/...
    ✓ [1] https://blog.cloudflare.com/...
    ✓ [2] https://github.com/cloudflare/workers-sdk/...
    ...
  ✓ agent done — 2 sources
  ...
→ writing report (8 sources)
✓ written (4,231 chars)
✓ done — 8 sources
```

## Install

```bash
# one-off
npx @steel-dev/atlas "<question>"

# project-local
npm install @steel-dev/atlas
```

Requires Node 20+.

## Get your keys (~2 min)

Atlas needs two keys you bring yourself:

| Key                 | Get it at                       |
| ------------------- | ------------------------------- |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com> |
| `STEEL_API_KEY`     | <https://app.steel.dev>         |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export STEEL_API_KEY=sk_...
```

## CLI

```bash
atlas "What's the state of the art in single-image novel view synthesis?"
```

By default, progress streams to stderr and the markdown report goes to stdout; so you can pipe:

```bash
atlas "..." > report.md
atlas "..." --out report.md            # write to file directly
atlas "..." --json 2> events.jsonl     # machine-readable event log
atlas "..." --quiet                    # no progress, just markdown
```

### Knobs

| Flag                   | Default | What it does                                              |
| ---------------------- | ------- | --------------------------------------------------------- |
| `--max-sources N`      | 12      | Cap on cited sources                                      |
| `--max-lead-turns N`   | 8       | Cap on lead-agent turns (each turn can spawn many scouts) |
| `--max-tool-calls N`   | 12      | Per-sub-agent tool-call cap (search + fetch)              |
| `--engine <e>`         | ddg     | Default web SERP: `ddg`, `bing`, or `google`              |
| `--use-proxy`          | off     | Route Steel through its residential proxy (paid add-on)   |
| `--fast-model <m>`     | Haiku   | Override the scout model                                  |
| `--writer-model <m>`   | Sonnet  | Override the writer model                                 |
| `--lead-model <m>`     | Sonnet  | Override JUST the lead-agent model (defaults to writer)   |

Cancel anytime with `Ctrl+C` — Atlas stops between steps and exits 130.

## Library

```ts
import { research } from "@steel-dev/atlas";

const result = await research({
  query: "What's the state of the art in single-image novel view synthesis?",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  steelApiKey: process.env.STEEL_API_KEY!,

  // all optional — same defaults as the CLI
  maxSources: 15,
  maxToolCalls: 18,
  engine: "google",

  // progress callback
  onEvent: (e) => {
    if (e.type === "source_committed") console.log(`  [${e.n}] ${e.url}`);
  },

  // cancellable
  signal: AbortSignal.timeout(180_000),
});

console.log(result.markdown);
console.log(`${result.sources.length} sources`);
```

### What you get back

```ts
interface ResearchResult {
  query: string;
  sub_questions: string[]; // sub-questions the lead actually spawned scouts for
  lead_turns: number; // how many turns the lead used
  agent_runs: AgentRun[]; // one per scout
  sources: CitedSource[]; // numbered, with title + url + originating sub-question
  markdown: string; // the report
  usage_summary: UsageSummary; // accumulated Anthropic token usage
}

interface AgentRun {
  sub_question: string;
  source_ns: number[]; // global n's of sources this scout contributed
  tool_calls: number; // search + fetch calls used
  finish_reason: string; // why the scout stopped
}
```

### Events

`onEvent` fires for: `lead_turn`, `agent_started`, `searching`, `search_results`, `search_failed`, `fetching`, `source_committed`, `source_error`, `agent_finished`, `writing`, `written`, `completed`. Per-scout events (everything between `agent_started` and `agent_finished` for a given sub-question) carry a `sub_question` field so you can demux parallel scouts. Full union types are exported as `ResearchEvent`.

## How it works

```
lead agent (Sonnet)
  tools: spawn_subagent / finalize
  ─ turn 1: decompose → spawn 3-5 scouts in parallel
  ─ turn 2 (optional): spot gaps, spawn 1-3 narrow followup scouts
  ─ call finalize() when coverage is good
        │
        ▼
┌──── per-scout sub-agent (all run in parallel) ────────┐
│  Haiku-driven loop with tools:                         │
│    search(query, source: web|arxiv|github|hn, site?)   │
│    fetch(url)   ← scrape + commit, returns snippet     │
│  Scout stops by emitting a final text message with     │
│  no tool calls. URL dedup, per-domain cap, global cap  │
│  enforced inside the tools — scout can't break them.   │
└────────────────────────────────────────────────────────┘
        │
        ▼
writer (Sonnet) — single pass, all sources + raw page text
        │
        ▼
   final report
```

- **Lead agent, not a fixed pipeline** — Atlas doesn't pre-decide how many sub-questions to ask or whether to do a "round 2." A Sonnet lead decides what to investigate, fires parallel scouts via the `spawn_subagent` tool, looks at what came back, and decides whether to spawn more or call `finalize`. The whole orchestration is in the model's hands, not in a hand-coded loop.
- **Parallel scout sub-agents** — each scout owns one sub-question and runs its own `search` / `fetch` loop. Easy questions finish in 3 tool calls; deep questions use the full budget. The scout picks its own queries and backends (web for general, arxiv for papers, github for code, hn for community).
- **Tools enforce invariants** — URL dedup, per-domain cap (≤2), and the global source cap live inside the tool implementations. No matter what the lead or scouts pick, the pool stays clean.
- **Single-shot fetch** — `fetch(url)` scrapes via Steel and atomically commits to the global pool, returning the assigned `[n]` plus a short page snippet so the scout can chase citations or pivot. No per-page summarization pass — the writer reads raw pages directly.
- **Citation chasing** — when a fetched page references another (a paper, an announcement, a doc), the scout can just `fetch` that URL next. One level deeper than SERP usually beats more searches.
- **Single-pass writer, full raw fidelity** — once the lead finalizes, the writer (Sonnet) sees ALL sources at full raw fidelity in one call. No outline planning, no per-section split — just write the report.
- **Cancellable** — `AbortSignal` (or `Ctrl+C` in CLI) cleanly stops between steps.
- **Bring your own LLM keys** — no Atlas hosted service, no telemetry. Spend is yours.

## Development

```bash
git clone https://github.com/steel-experiments/atlas
cd atlas
npm install

# run directly without building
npm run dev -- "your question"

# typecheck, test, build
npm run typecheck
npm run test
npm run build
```

## License

MIT.
