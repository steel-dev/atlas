# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research from your terminal or your code.**

Ask a question, get back a cited markdown report. Powered by [Steel Browser](https://steel.dev) and [Anthropic Claude](https://www.anthropic.com/).

```bash
npx @steel-dev/atlas "What changed when Cloudflare Durable Objects added SQLite?"
```

```
→ lead planning: What changed when Cloudflare Durable Objects added SQLite?
  turn 1: spawning 4 scouts
  ↳ scout: When did SQLite-backed Durable Objects ship?
  ↳ scout: What new capabilities did SQLite unlock?
  ↳ scout: What limits or trade-offs come with the SQLite backend?
  ↳ scout: How does SQLite-backed DO compare to the KV backend?
    search: [web] cloudflare durable objects sqlite release date
      ↳ 5 results
    fetch: https://blog.cloudflare.com/...
    ✓ [1] https://blog.cloudflare.com/...
    ✓ [2] https://github.com/cloudflare/workers-sdk/...
    ...
  ✓ agent done — 2 sources
  ...
✓ lead finalized — 8 sources gathered
  notes: cover (1) release timeline, (2) capability deltas vs KV, (3) limits.
→ writing report (8 sources)
✓ written (4,231 chars)
→ verifying 11 claims
  ✓ [1] (1/11)
  ✓ [2] (2/11)
  ...
✓ done — 8 sources, 11/11 claims supported (100%)
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
| `--max-tool-calls N`   | 12      | Per-sub-agent tool-call cap (search / fetch / finish)     |
| `--engine <e>`         | ddg     | Default web SERP: `ddg`, `bing`, or `google`              |
| `--use-proxy`          | off     | Route Steel through its residential proxy (paid add-on)   |
| `--fast-model <m>`     | Haiku   | Override scout / page-summarize / verify model            |
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
    if (e.type === "summarized") console.log(`  [${e.n}] ${e.url}`);
  },

  // cancellable
  signal: AbortSignal.timeout(180_000),
});

console.log(result.markdown);
console.log(
  `${result.verification_summary.supported}/${result.verification_summary.total} claims verified`,
);
```

### What you get back

```ts
interface ResearchResult {
  query: string;
  sub_questions: string[]; // sub-questions the lead actually spawned scouts for
  lead_notes: string; // optional notes the lead passed to the writer
  lead_turns: number; // how many turns the lead used
  agent_runs: AgentRun[]; // one per scout
  sources: CitedSource[]; // numbered, with verbatim excerpts
  markdown: string; // the report
  verifications: ClaimVerification[]; // per-claim verdicts
  verification_summary: {
    total: number;
    supported: number;
    unsupported: number;
    pass_rate: number;
  };
  usage_summary: UsageSummary; // accumulated Anthropic token usage
}

interface AgentRun {
  sub_question: string;
  source_ns: number[]; // global n's of sources this scout contributed
  tool_calls: number; // search + fetch + finish calls used
  finish_reason: string; // why the scout stopped
}
```

### Events

`onEvent` fires for: `lead_started`, `lead_turn`, `subagent_spawned`, `lead_finalize`, `agent_started`, `searching`, `search_results`, `search_failed`, `fetching`, `summarized`, `source_skipped`, `source_error`, `agent_finished`, `writing`, `written`, `verifying`, `verified_claim`, `completed`. Per-scout events (everything between `agent_started` and `agent_finished` for a given sub-question) carry a `sub_question` field so you can demux parallel scouts. Full union types are exported as `ResearchEvent`.

## How it works

```
lead agent (Sonnet)
  tools: spawn_subagent / finalize
  ─ turn 1: decompose → spawn 3-5 scouts in parallel
  ─ turn 2 (optional): spot gaps, spawn 1-3 narrow followup scouts
  ─ call finalize(notes) when coverage is good
        │
        ▼
┌──── per-scout sub-agent (all run in parallel) ────────┐
│  Haiku-driven loop with tools:                         │
│    search(query, source: web|arxiv|github|hn, site?)   │
│    fetch(url)   ← scrape + summarize + commit          │
│    finish(reason)                                      │
│  URL dedup, per-domain cap, global cap enforced        │
│  inside the tools — scout can't break them.            │
└────────────────────────────────────────────────────────┘
        │
        ▼
writer (Sonnet) — single pass, all sources + raw page text
        │
        ▼
verify every [n] citation (Haiku reads the raw page text,
                            excerpts are hints only)
        │
        ▼
   final report
```

- **Lead agent, not a fixed pipeline** — Atlas doesn't pre-decide how many sub-questions to ask or whether to do a "round 2." A Sonnet lead decides what to investigate, fires parallel scouts via the `spawn_subagent` tool, looks at what came back, and decides whether to spawn more or call `finalize`. The whole orchestration is in the model's hands, not in a hand-coded loop.
- **Parallel scout sub-agents** — each scout owns one sub-question and runs its own `search` / `fetch` / `finish` loop. Easy questions finish in 3 tool calls; deep questions use the full budget. The scout picks its own queries and backends (web for general, arxiv for papers, github for code, hn for community).
- **Tools enforce invariants** — URL dedup, per-domain cap (≤2), and the global source cap live inside the tool implementations. No matter what the lead or scouts pick, the pool stays clean.
- **Targeted fetch** — `fetch(url)` scrapes via Steel, summarizes against the sub-question, and atomically commits to the global pool if relevant. Irrelevant pages return a "not committed" message so the scout learns.
- **Citation chasing** — when a fetched source references another (a paper, an announcement, a doc), the scout can just `fetch` that URL next. One level deeper than SERP usually beats more searches.
- **Single-pass writer, full raw fidelity** — once the lead finalizes, the writer (Sonnet) sees ALL sources at full raw fidelity in one call. No outline planning, no per-section split — just write the report. The pre-finalize source pool is the writer's working set.
- **Citations verified against raw pages** — each `[n]` marker is checked by Haiku reading the raw page text (the ground truth), with summary + excerpts as convenience hints only. This breaks the circularity where verifying against the scout's own summary would just rubber-stamp whatever the scout said.
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
