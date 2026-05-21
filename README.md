# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research from your terminal or your code.**

Ask a question, get back a cited markdown report. Powered by [Steel Browser](https://steel.dev) and [Anthropic Claude](https://www.anthropic.com/).

```bash
npx @steel-dev/atlas "What changed when Cloudflare Durable Objects added SQLite?"
```

```
  → agent started [What changed when Clo...]
    search: cloudflare durable objects sqlite release date
      ↳ 5 results
    fetch: https://blog.cloudflare.com/...
    ✓ [1] https://blog.cloudflare.com/...
    search: durable objects sqlite docs limits
      ↳ 5 results
    fetch: https://developers.cloudflare.com/...
    ✓ [2] https://developers.cloudflare.com/...
  ✓ agent done — 8 sources
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

| Flag                 | Default  | What it does                                            |
| -------------------- | -------- | ------------------------------------------------------- |
| `--depth <d>`        | standard | Budget preset: `fast`, `standard`, or `deep`            |
| `--max-sources N`    | 16       | Cap on cited sources                                    |
| `--max-tool-calls N` | 20       | Gather-agent tool-call cap (search + fetch + done)      |
| `--engine <e>`       | ddg      | Default web SERP: `ddg`, `bing`, or `google`            |
| `--use-proxy`        | off      | Route Steel through its residential proxy (paid add-on) |
| `--fast-model <m>`   | Haiku    | Override the gather model                               |
| `--writer-model <m>` | Sonnet   | Override the writer model                               |

Cancel anytime with `Ctrl+C` — Atlas stops between steps and exits 130.

## Library

```ts
import { research } from "@steel-dev/atlas";

const result = await research({
  query: "What's the state of the art in single-image novel view synthesis?",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  steelApiKey: process.env.STEEL_API_KEY!,

  // all optional — same defaults as the CLI
  depth: "standard",
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
  agent_runs: AgentRun[]; // one gather-agent run
  sources: CitedSource[]; // numbered, with title + url
  markdown: string; // the report
  usage_summary: UsageSummary; // accumulated Anthropic token usage
}

interface AgentRun {
  source_ns: number[]; // global n's of sources the gather agent contributed
  tool_calls: number; // search + fetch calls used
  finish_reason: string; // why the gather agent stopped
}
```

### Events

`onEvent` fires for: `agent_started`, `searching`, `search_results`, `search_failed`, `fetching`, `source_committed`, `source_error`, `agent_finished`, `writing`, `written`, `completed`. Full union types are exported as `ResearchEvent`.

## How it works

```
gather agent (Haiku)
  tools:
    search(query)
    fetch(url)   ← scrape + commit, returns snippet
    done()
  hard invariants:
    URL dedup, global source cap, Steel concurrency gate,
    in-run SERP/cache reuse
        │
        ▼
writer (Sonnet) — single pass, packed source text
        │
        ▼
   final report
```

- **One gather loop, not an orchestration tree** — Atlas lets a Haiku gather agent search, fetch, chase citations, and call `done`; there is no lead/scout hierarchy.
- **Tools enforce hard invariants** — URL dedup, the global source cap, one Steel concurrency gate, and in-run caches live inside the tools. Domain diversity and search strategy stay in the model prompt, not hand-written filters.
- **Single-shot fetch** — `fetch(url)` scrapes via Steel and atomically commits to the global pool, returning the assigned `[n]` plus a short page snippet so the agent can chase citations or pivot. No per-page summarization pass.
- **Citation chasing** — when a fetched page references another source, the agent can just `fetch` that URL next. One level deeper than SERP usually beats more searches.
- **Single-pass writer** — once gathering finishes, the writer (Sonnet) sees packed source text in one call. No outline planning, no per-section split — just write the report.
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
