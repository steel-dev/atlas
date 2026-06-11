# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**One question in. Verified, cited report out.**

Model-agnostic deep research: any [AI SDK 6](https://sdk.vercel.ai) `LanguageModel`, one shared budget, claims checked against source text before they hit your report.

```ts
import { Atlas } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const atlas = new Atlas({ model: anthropic("claude-fable-5") });
const { report } = await atlas.research(
  "What's changing in browser automation for AI agents?",
);
```

## Install

```bash
npm install @steel-dev/atlas ai @ai-sdk/anthropic
# or @ai-sdk/openai / @ai-sdk/google
```

## How it works

A lead agent plans, researches (or spawns subagents), verifies claims, and writes the report. Topology isn't configured: simple questions stay single-agent; broad surveys fan out on their own.

Long runs don't stall out: when the lead's context fills, it re-anchors in a fresh context from the claim ledger (`lead.recontexted`), and before synthesis a coverage audit sends it back after concrete gaps while budget remains (`coverage.assessed`).

| Phase | What happens |
| ----- | ------------ |
| **Plan** | Inline answer or spawn workers on facets (`plan.updated`) |
| **Act** | Search, fetch, extract verbatim-quoted claims into a shared ledger |
| **Verify** | Screen cheaply; central claims get a 3-lens adversarial panel |
| **Bind** | Draft → sentence-level citation check → repair or drop failures |

```
fast question  → one search, one fetch, done
broad survey   → research subagents + verified central claims
```

## Budget

One meter for everything. Set effort or cap with `budget.maxUSD`.

| effort | ~budget | depth | spawns/turn |
| ------ | ------- | ----- | ----------- |
| `fast` | $0.50 | 1 | 1 |
| `balanced` | $2.50 | 2 | 4 |
| `deep` | $10 | 3 | 8 |
| `max` | $40 | 4 | 12 |

```ts
await atlas.research(question, { effort: "deep", budget: { maxUSD: 5 } });
```

## Stream it

```ts
const run = atlas.start(question, { effort: "balanced" });

for await (const e of run.events()) {
  if (e.type === "report.delta") process.stdout.write(e.text);
  if (e.type === "claim.verified") console.error(e.status, e.claimId);
}

const result = await run.result();
```

`report.delta` streams a live preview; `report.completed` is canonical after binding. `run.stop()` synthesizes from whatever's in the ledger; `run.cancel()` aborts. Late subscribers get full event history.

## Results

```ts
result.report;              // cited markdown
result.citations;           // spans + quotes + verification
result.claims.confirmed;    // passed full panel
result.claims.screened;     // cheap check only
result.claims.contested;    // sources disagree, surfaced
result.structured;            // typed output (optional)
result.stats;               // cost, tokens, agents spawned, …
```

Structured output: pass a Zod schema via `output: { kind: "structured", schema }`. Per-field citations land in `result.structuredBasis`.

## Resume & providers

Journaled runs replay completed model/search/fetch calls at zero cost after crash or deploy:

```ts
import { Atlas, fileStore } from "@steel-dev/atlas";

const store = fileStore("./runs");
const atlas = new Atlas({ model, store });
atlas.start(question, { runId: "run_42" });
// …restart…
await Atlas.resume("run_42", { model, store });
```

**Search:** `tavily()` / `exa()` / `brave()` (auto from env keys) or provider-native search.

**Fetch:** `basicFetch()` by default; `steel()` for JS-rendered pages when `STEEL_API_KEY` is set.

```ts
import { Atlas, exa, steel, basicFetch } from "@steel-dev/atlas";

const atlas = new Atlas({
  model,
  search: exa(),
  fetch: [basicFetch(), steel({ proxy: true })],
});
```

## Extend it

Plug in domain sources with `researchTool`: anything via `ctx.addSource` flows through the same ledger and verification:

```ts
import { Atlas, researchTool } from "@steel-dev/atlas";

const atlas = new Atlas({
  model,
  tools: {
    pubmed_search: researchTool({
      description: "Search PubMed.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }, ctx) => {
        const studies = await pubmed.search(query, { signal: ctx.signal });
        for (const s of studies) ctx.addSource({ url: s.url, title: s.title, content: s.abstract });
        return studies.map((s) => `- ${s.title}`).join("\n");
      },
    }),
  },
});
```

**Models per role:** override `models.extract` / `models.verify` (defaults to a small sibling for Anthropic/OpenAI when keys are present).

**Concurrency:** `concurrency: { models: 8, io: 10 }` or `ATLAS_MODEL_CONCURRENCY` / `ATLAS_IO_CONCURRENCY`.

## Safety

Untrusted web content is quarantined (data, not instructions). Fetches pass SSRF guards hop-by-hop; `run_code` runs in an isolated subprocess. Direct fetch honors robots.txt.

## Dev

```bash
git clone https://github.com/steel-experiments/atlas.git && cd atlas
npm install && npm run dev -- "your question"
```

- `examples/cli.ts`: terminal runs
- `examples/serve.ts`: SSE web app
- `evals/`: BrowseComp + DRACO (`npm run eval:browsecomp`, `npm run eval:draco`)

## License

MIT
