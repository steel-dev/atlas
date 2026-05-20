# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research from your terminal or your code.**

Ask a question, get back a cited markdown report.
Atlas plans sub-questions, searches the web, reads pages with a real browser,
writes a report, and verifies every citation against its source.

Powered by [Steel Browser](https://steel.dev) and [Anthropic Claude](https://www.anthropic.com/).
No infrastructure, no deploy — just an npm package.

```bash
npx @steel-dev/atlas "What changed when Cloudflare Durable Objects added SQLite?"
```

```
✓ brief
  I want to understand what changed when Cloudflare Durable Objects gained
  SQLite-backed storage — what new capabilities it unlocked, when it shipped,
  and any limits or trade-offs.
  3 sub-questions
    • When did SQLite-backed Durable Objects ship?
    • What new capabilities did SQLite unlock?
    • What limits or trade-offs come with the SQLite backend?
→ round 1 — 3 queries
  ✓ [1] https://blog.cloudflare.com/...
  ✓ [2] https://developers.cloudflare.com/...
  ✓ [3] https://news.ycombinator.com/...
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

By default, progress streams to stderr and the markdown report goes to stdout — so you can pipe:

```bash
atlas "..." > report.md
atlas "..." --out report.md            # write to file directly
atlas "..." --json 2> events.jsonl     # machine-readable event log
atlas "..." --quiet                    # no progress, just markdown
```

### Knobs

| Flag                    | Default | What it does                                                       |
| ----------------------- | ------- | ------------------------------------------------------------------ |
| `--max-sub-questions N` | 4       | How many sub-questions to plan                                     |
| `--max-results-per-q N` | 5       | SERP results per sub-question                                      |
| `--max-sources N`       | 12      | Cap on cited sources                                               |
| `--max-hops N`          | 3       | Max extra search rounds; loop early-exits when sufficient          |
| `--fetch-concurrency N` | 5       | How many pages fetch + summarize in parallel                       |
| `--queries-per-subq N`  | 3       | Search queries Haiku expands each sub-question into                |
| `--no-critique`         | off     | Disable the post-draft peer-review pass                            |
| `--verify-threshold F`  | 0.7     | Min fraction of claims that must verify; below → rewrite           |
| `--engine <e>`          | ddg     | `ddg`, `bing`, or `google`                                         |
| `--use-proxy`           | off     | Route Steel through its residential proxy (paid add-on)            |
| `--fast-model <m>`      | Haiku   | Override the per-page / verify / critique-non-writer model         |
| `--writer-model <m>`    | Sonnet  | Override the report writer and critique reviewer model             |

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
  maxHops: 3,
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
  agent_runs: AgentRun[]; // one per sub-question, with its own assess history
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
  expanded_queries: string[];
  source_ns: number[]; // global n's of sources this agent contributed
  rounds: number;
  assessments: AssessmentRecord[]; // mini-assess per round
}
```

### Events

`onEvent` fires for: `brief`, `expanded_queries`, `agent_started`, `round_started`, `searching`, `search_results`, `search_failed`, `fetching`, `summarized`, `source_skipped`, `source_error`, `assessing`, `assessment`, `agent_finished`, `writing`, `written`, `critiquing`, `critique_done`, `verifying`, `verified_claim`, `verify_failed`, `completed`. Per-agent events (everything between `agent_started` and `agent_finished` for a given sub-question) carry a `sub_question` field so you can demux parallel agents. Full union types are exported as `ResearchEvent`.

## How it works

```
plan brief + sub-questions             (Haiku)
       │
       ▼
expand each sub-question into N        (Haiku — angles: definition,
queries from different angles            recency, comparison, criticism)
       │
       ▼
┌──── per-sub-question agent (all run in parallel) ─────┐
│  search each expanded query                            │
│            ↓                                           │
│  fetch + per-page summarize (parallel within agent)    │
│            ↓                                           │
│  mini-assess this agent's coverage ◄── loop ──┐        │
│            │                                  │        │
│            ▼  (gaps? more queries)            │        │
│  ─────────────────────────────────────────────┘        │
└────────────────────────────────────────────────────────┘
       │
       ▼  (synthesizer sees all sub-question
       ▼   sources + raw page markdown)
write report                           (Sonnet)
       │
       ▼
peer-review critique                   (Sonnet — substantive issues only)
       │
       ▼
verify every [n] citation              (Haiku, parallel batches)
       │
       ▼
critique-fail OR verify-fail?
  ── yes ──► rewrite once with both signals fed back
       │ no
       ▼
   final report
```

- **Query expansion** — each sub-question fans out into N short queries hitting it from different angles (definition / recency / comparison / criticism / primary sources). One Haiku call up front; SERP recall jumps without changing search backend.
- **Per-sub-question agents** — each sub-question becomes its own agent running a full search → fetch → mini-assess loop in parallel with the others. Agents share a global source pool (URL dedupe, per-domain cap) but each gets its own depth budget and decides for itself whether to dig deeper. This is the key SOTA-ish lever vs. a flat shared queue: every sub-question gets actual depth rather than competing in one pool.
- **Parallel fetch + summarize** — within each agent, pages get pulled and summarized concurrently, so wall-clock scales with the slowest source, not the sum.
- **Gap-driven depth** — each agent's mini-assess early-exits when its own sub-question is sufficiently covered, and only spends another round when it can name a concrete gap.
- **Writer sees full pages** — the Sonnet writer is given each source's summary, verbatim excerpts, AND the raw page markdown (truncated per-source). Most OSS pipelines hand the writer only summaries; atlas hands it the source material so it can find specifics summaries miss.
- **Peer-review critique** — after each draft, a Sonnet reviewer reads the report against the brief and sub-questions, flagging substantive issues (unaddressed sub-questions, weak hedging, missed contradictions, surface restatement). If it flags issues OR citation verification falls below threshold, one rewrite is triggered with both signals fed in.
- **Sources dedupe** across rounds and cap per domain (≤2) so one site can't dominate.
- **Citations are verified** — each `[n]` marker is checked against the source's verbatim excerpts. Below `verify_threshold` triggers exactly one rewrite that's told which claims failed.
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
