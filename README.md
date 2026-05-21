# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research from your terminal or your code.**

Ask a question, get back a cited markdown report. Powered by [Steel Browser](https://steel.dev) and [Anthropic Claude](https://www.anthropic.com/).

```bash
npx @steel-dev/atlas "What changed when Cloudflare Durable Objects added SQLite?"
```

```
✓ brief
  I want to understand what changed when Cloudflare Durable Objects gained
  SQLite-backed storage - what new capabilities it unlocked, when it shipped,
  and any limits or trade-offs.
  3 sub-questions
    • When did SQLite-backed Durable Objects ship?
    • What new capabilities did SQLite unlock?
    • What limits or trade-offs come with the SQLite backend?
→ agent: When did SQLite-backed Durable Objects ship?
  search: [web] cloudflare durable objects sqlite release date
    ↳ 5 results
  fetch: https://blog.cloudflare.com/...
  ✓ [1] https://blog.cloudflare.com/...
→ agent: What new capabilities did SQLite unlock?
  search: [github] cloudflare/workers-sdk sqlite durable object
    ↳ 4 results
  ✓ [2] https://github.com/cloudflare/workers-sdk/...
→ writing report (attempt 1, 6 sources)
→ verifying 11 claims
  ✓ [1] (1/11)
  ✓ [2] (2/11)
  ...
✓ done — 6 sources, 11/11 claims supported (100%)
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

| Flag                    | Default | What it does                                               |
| ----------------------- | ------- | ---------------------------------------------------------- |
| `--max-sub-questions N` | 4       | How many sub-questions to plan                             |
| `--max-sources N`       | 12      | Cap on cited sources                                       |
| `--max-tool-calls N`    | 12      | Per-sub-agent tool-call cap (search / fetch / finish)      |
| `--no-critique`         | off     | Disable the post-draft peer-review pass                    |
| `--verify-threshold F`  | 0.7     | Min fraction of claims that must verify; below → rewrite   |
| `--engine <e>`          | ddg     | Default web SERP: `ddg`, `bing`, or `google`               |
| `--use-proxy`           | off     | Route Steel through its residential proxy (paid add-on)    |
| `--fast-model <m>`      | Haiku   | Override the scout / page / verify / critique model        |
| `--writer-model <m>`    | Sonnet  | Override the report writer and critique reviewer model     |

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
  signal: AbortSignal.timeout(120_000),
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
  brief: string; // first-person research brief
  sub_questions: string[]; // planned decomposition
  agent_runs: AgentRun[]; // one per sub-question
  sources: CitedSource[]; // numbered, with verbatim excerpts
  markdown: string; // the report
  critiques: CritiqueResult[]; // one per write attempt
  attempts: number; // 1 or 2 (one rewrite allowed)
  pass_rate_history: number[]; // verify pass rate per attempt
  verifications: ClaimVerification[]; // per-claim verdicts
  verification_summary: {
    total: number;
    supported: number;
    unsupported: number;
    pass_rate: number;
  };
}

interface AgentRun {
  sub_question: string;
  source_ns: number[]; // global n's of sources this agent contributed
  tool_calls: number; // search + fetch + finish calls used
  finish_reason: string; // why the agent stopped
}
```

### Events

`onEvent` fires for: `brief`, `agent_started`, `searching`, `search_results`, `search_failed`, `fetching`, `summarized`, `source_skipped`, `source_error`, `agent_finished`, `outlining`, `outline_done`, `section_writing`, `section_written`, `writing`, `written`, `critiquing`, `critique_done`, `verifying`, `verified_claim`, `verify_failed`, `completed`. Per-agent events (everything between `agent_started` and `agent_finished` for a given sub-question) carry a `sub_question` field so you can demux parallel agents. Full union types are exported as `ResearchEvent`.

## How it works

```
plan brief + sub-questions             (Haiku)
       │
       ▼
┌──── per-sub-question scout (all run in parallel) ─────┐
│  Haiku-driven loop with tools:                         │
│    search(query, source: web|arxiv|github|hn, site?)   │
│    fetch(url)   ← scrape + summarize + commit          │
│    finish(reason)                                      │
│  Budget: max_tool_calls + agent_source_cap.            │
│  URL dedup, per-domain cap, global cap enforced        │
│  inside the tools — agent can't break them.            │
└────────────────────────────────────────────────────────┘
       │
       ▼  (outline from source summaries, then per-section
       ▼   parallel writes with each section seeing ONLY its
       ▼   own sources at full raw fidelity)
plan outline → write sections          (Sonnet)
       │
       ▼
peer-review critique                   (Sonnet — substantive issues only)
       │
       ▼
verify every [n] citation              (Haiku reads the raw page text,
                                         excerpts are hints only)
       │
       ▼
critique-fail OR verify-fail?
  ── yes ──► single-pass rewrite with both signals fed back
       │ no
       ▼
   final report
```

- **Tool-driven scouts** — each sub-question runs a Haiku loop with `search` / `fetch` / `finish`. The scout decides its own queries (no fixed expansion), its own backends (web for general, arxiv for papers, github for code, hn for community), and when to stop. Easy questions finish in 3 tool calls; deep questions use the full budget.
- **Tools enforce invariants** — URL dedup, per-domain cap (≤2), and the global source cap live inside the tool implementations. No matter what the scout picks, the pool stays clean.
- **Targeted fetch** — `fetch(url)` scrapes via Steel, summarizes against the sub-question, and atomically commits to the global pool if relevant. Irrelevant pages return a "not committed" message so the scout learns.
- **Citation chasing** — when a fetched source references another (a paper, an announcement, a doc), the scout can just `fetch` that URL next. One level deeper than SERP usually beats more searches.
- **Section-by-section writer** — first attempt plans an outline (Sonnet, from summaries only) then writes each section in parallel with ONLY that section's sources at full raw fidelity. The writer never has to do internal retrieval over the whole source pool, which is the usual hallucination vector. Retry (attempt 2) uses a single-pass rewrite so per-claim feedback can land cleanly.
- **Peer-review critique** — after each draft, a Sonnet reviewer reads the report against the brief and sub-questions, flagging substantive issues (unaddressed sub-questions, weak hedging, missed contradictions, surface restatement). If it flags issues OR citation verification falls below threshold, one rewrite is triggered with both signals fed in.
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
