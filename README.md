# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research from your terminal or your code.**

Ask a question, get back a cited markdown report.
Atlas plans sub-questions, searches the web, reads pages with a real browser,
writes a report, and verifies every citation against its source.

Powered by [Steel Browser](https://steel.dev) and [Anthropic Claude](https://www.anthropic.com/).
No infrastructure, no deploy — just an npm package.

```bash
npx atlas "What changed when Cloudflare Durable Objects added SQLite?"
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
npx atlas "<question>"

# project-local
npm install atlas
```

Requires Node 20+.

## Get your keys (~2 min)

Atlas needs two keys you bring yourself:

| Key                  | Get it at                                                                           |
| -------------------- | ----------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | <https://console.anthropic.com>                                                     |
| `STEEL_API_KEY`      | <https://app.steel.dev>                                                             |

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

| Flag                      | Default | What it does                                              |
| ------------------------- | ------- | --------------------------------------------------------- |
| `--max-sub-questions N`   | 4       | How many sub-questions to plan                            |
| `--max-results-per-q N`   | 5       | SERP results per sub-question                             |
| `--max-sources N`         | 12      | Cap on cited sources                                      |
| `--max-hops N`            | 2       | Extra rounds of search-and-fetch beyond the first         |
| `--verify-threshold F`    | 0.7     | Min fraction of claims that must verify; below → rewrite  |
| `--engine <e>`            | ddg     | `ddg`, `bing`, or `google`                                |
| `--use-proxy`             | off     | Route Steel through its residential proxy (paid add-on)   |
| `--fast-model <m>`        | Haiku   | Override the per-page / verify model                      |
| `--writer-model <m>`      | Sonnet  | Override the report writer model                          |

Cancel anytime with `Ctrl+C` — Atlas stops between steps and exits 130.

## Library

```ts
import { research } from "atlas";

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
console.log(`${result.verification_summary.supported}/${result.verification_summary.total} claims verified`);
```

### What you get back

```ts
interface ResearchResult {
  query: string;
  brief: string;                          // first-person research brief
  sub_questions: string[];                // planned decomposition
  sources: CitedSource[];                 // numbered, with verbatim excerpts
  markdown: string;                       // the report
  assessments: AssessmentRecord[];        // per-round coverage decisions
  rounds: number;                         // how many search rounds ran
  attempts: number;                       // 1 or 2 (one rewrite allowed)
  pass_rate_history: number[];            // verify pass rate per attempt
  verifications: ClaimVerification[];     // per-claim verdicts
  verification_summary: {
    total: number;
    supported: number;
    unsupported: number;
    pass_rate: number;
  };
}
```

### Events

`onEvent` fires for: `brief`, `round_started`, `searching`, `search_results`, `search_failed`, `fetching`, `summarized`, `source_skipped`, `source_error`, `assessing`, `assessment`, `writing`, `written`, `verifying`, `verified_claim`, `verify_failed`, `completed`. Full union types are exported as `ResearchEvent`.

## How it works

```
plan brief + sub-questions          (Haiku)
       │
       ▼
search each sub-question            (Steel — DDG / Bing / Google SERP)
       │
       ▼
fetch + per-page summarize          (Steel + Haiku)
       │
       ▼
assess coverage ◄────── loop ──────►
       │  (sufficient?)
       ▼
write report                        (Sonnet)
       │
       ▼
verify every [n] citation           (Haiku, parallel batches)
       │
       ▼
pass rate ≥ threshold? ── no ──► rewrite once with unsupported claims marked
       │ yes
       ▼
   final report
```

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
