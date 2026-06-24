![Atlas — Research Agent for the Open Web](assets/cover.png)

# Atlas

**Research Agent for the Open Web**

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

**Search:** `tavily.search()` / `exa.search()` / `brave.search()` (auto from env keys) or provider-native search.

**Fetch:** `basicFetch()` by default; `steel.fetch()` for JS-rendered pages when `STEEL_API_KEY` is set.

```ts
import { Atlas, exa, steel, basicFetch } from "@steel-dev/atlas";

const atlas = new Atlas({
  model,
  search: exa.search(),
  fetch: [basicFetch(), steel.fetch({ proxy: true })],
});
```

## Orchestrate researchers

Register other research agents — including Atlas itself — as a fleet. Atlas decomposes the question, routes each sub-task to the best-fit researcher (`query → report`), runs them in isolation, then synthesizes one cited report. With no `researchers` set it stays a single spine run.

```ts
import { Atlas, exa } from "@steel-dev/atlas";

const atlas = new Atlas({
  model,
  researchers: {
    exa: exa.agent(), // Exa's deep-research agent, via exa-js
  },
});

await atlas.research("Compare X across academic and shopping angles");
```

Any `query → report` worker plugs in via `researcher({ describe, research })` — `describe` drives routing. `atlas.asResearcher(describe)` exposes an Atlas instance as a worker, so fan-out can recurse.

## Extend it

Plug in domain sources with `researchTool`: anything via `ctx.addSource` flows through the same source store:

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
        for (const s of studies)
          ctx.addSource({ url: s.url, title: s.title, content: s.abstract });
        return studies.map((s) => `- ${s.title}`).join("\n");
      },
    }),
  },
});
```

**Models per role:** override `models.extract` (claim extraction) or any stage model (`models.research`, `models.write`); each defaults to a small sibling for Anthropic/OpenAI/Z.ai when keys are present, else the lead model.

**Z.ai / GLM:** use Z.ai through its OpenAI-compatible endpoint:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { Atlas, tavily } from "@steel-dev/atlas";

const zai = createOpenAI({
  apiKey: process.env.ZAI_API_KEY!,
  baseURL: "https://api.z.ai/api/paas/v4",
});

const atlas = new Atlas({
  model: zai.chat("glm-5.2"),
  search: tavily.search(),
});
```

The examples also accept `--provider zai` with `ZAI_API_KEY` / `ATLAS_ZAI_API_KEY`. GLM lead models derive `glm-4.5-air` for extraction when a Z.ai key is present. Configure `tavily.search()`, `exa.search()`, or `brave.search()` for search; Atlas does not map Z.ai's web-search API to an AI SDK native search tool.

**Concurrency:** `concurrency: { models: 8, io: 10 }` or `ATLAS_MODEL_CONCURRENCY` / `ATLAS_IO_CONCURRENCY`.

## Stream it

```ts
const run = atlas.start(question, { effort: "balanced" });

for await (const e of run.events()) {
  if (e.type === "report.delta") process.stdout.write(e.text);
  if (e.type === "source.fetched") console.error(e.url);
}

const result = await run.result();
```

`report.delta` streams a live preview; `report.completed` is canonical after binding. `run.stop()` synthesizes from whatever's gathered so far; `run.cancel()` aborts. Late subscribers get full event history.

## Resume & providers

Journaled runs replay completed model/search/fetch calls at zero cost after crash or deploy:

```ts
import { Atlas, fileStore } from "@steel-dev/atlas";

const store = fileStore("./runs");
const atlas = new Atlas({ model, store });
atlas.start(question, { runId: "run_42" });
// …restart…
await new Atlas({ model, store }).resume("run_42");
```

## Results

```ts
result.report; // cited markdown
result.citations; // source citations
result.sources; // fetched sources, tagged by researcher
result.stats; // cost, tokens, duration, …
```

## Budget

One meter for everything. Pick an effort, or override any cap with `budget`.

| effort     | ~budget | depth | sources | agents | tokens |
| ---------- | ------- | ----- | ------- | ------ | ------ |
| `fast`     | $0.50   | 1     | 15      | 20     | 5M     |
| `balanced` | $2.50   | 2     | 40      | 80     | 20M    |
| `deep`     | $10     | 3     | 100     | 250    | 80M    |
| `max`      | $40     | 4     | 250     | 800    | 250M   |

```ts
await atlas.research(question, {
  effort: "deep",
  budget: { maxUSD: 5, maxTokens: 50_000_000, maxAgents: 100 },
});
```

`maxUSD` is a **best-effort target, not a hard ceiling.** The meter checks between agent turns, so a run stops *starting* work once spent, but in-flight calls (up to `concurrency.models`) can overshoot. Pricing comes from a built-in table that can lag provider changes — pass `pricing` to correct a rate when the cap must be accurate.

The real backstops are **price-independent** — each defaults to the effort row above and is enforced regardless of prices:

- `budget.maxTokens` — input + output tokens run-wide (cache reads excluded). Checked between turns like `maxUSD`, but never drifts with prices.
- `budget.maxAgents` — run-wide cap on the research agents a run may use.
- `budget.maxSources`, `budget.maxDurationMs` — fetched-source and wall-clock caps.

`result.stats` reports `budgetExhausted`, `tokensExhausted`, and `agentCapReached` so you can see which limit bound the run. Leave headroom on `maxUSD`, or set a provider-side spend limit, when the cap is truly hard.

`result.stats.stopReason` folds those into one value — `"answered"`, `"completed"`, `"stopped"` (`run.stop()`), or a binding cap (`"budget"`, `"tokens"`, `"timeout"`, `"agent-cap"`). When several apply, the most proximate wins.

## Safety

Untrusted web content is quarantined (data, not instructions). Fetches pass SSRF guards hop-by-hop; `run_code` runs in a memory-capped V8 isolate with no network, filesystem, or host access. Direct fetch honors robots.txt.

The isolate needs the optional `isolated-vm` dependency; without it, `run_code` is dropped from the toolset and the run proceeds without it — Atlas never falls back to an unsandboxed evaluator.

The SSRF guard validates DNS at check time but can't pin the connection, so an attacker controlling DNS can defeat it via rebinding. Treat it as defense-in-depth — for hostile targets, run behind network-level egress controls that block private ranges.

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
