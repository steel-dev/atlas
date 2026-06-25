![Atlas — Research Agent for the Open Web](cover.png)

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

**Search:** `tavily.search()` / `exa.search()` / `brave.search()` (auto from env keys), or `native.search({ model })` to use the model provider's own web search.

**Fetch:** `basic.fetch()` by default; `steel.fetch()` for JS-rendered pages when `STEEL_API_KEY` is set.

```ts
import { Atlas, exa, steel, basic } from "@steel-dev/atlas";

const atlas = new Atlas({
  model,
  search: exa.search(),
  fetch: [basic.fetch(), steel.fetch({ proxy: true })],
});
```

## Orchestrate researchers

Register other research agents — including Atlas itself — as a fleet. Atlas decomposes the question, routes each sub-task to the best-fit researcher (`query → report`), runs them in isolation, then synthesizes one cited report. With no `researchers` set it stays a single spine run.

```ts
import { Atlas, exa, perplexity, parallel } from "@steel-dev/atlas";

const atlas = new Atlas({
  model,
  researchers: {
    exa: exa.agent(), // Exa deep-research (via exa-js)
    perplexity: perplexity.agent(), // Perplexity Sonar
    parallel: parallel.agent(), // parallel.ai task API
  },
});

await atlas.research("Compare X across academic and shopping angles");
```

Any `query → report` worker plugs in via `researcher({ describe, research })` — `describe` drives routing. `atlas.asResearcher(describe)` exposes an Atlas instance as a worker, so fan-out can recurse. A worker returns `{ report, sources }` and may add `cost` (USD) and `confidence` (0–1, a soft hint surfaced to synthesis).

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

`ctx` (`ToolContext`) provides `addSource({ url, title?, content })`, `fetchText(url)` (a guarded fetch returning extracted text or `null`), `log(message)`, and `signal`.

**Models per role:** the top-level `model` is the lead; override the stage models with `models.research` and `models.write`. Each defaults to the lead model when unset.

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

The examples also accept `--provider zai` with `ZAI_API_KEY` / `ATLAS_ZAI_API_KEY`. Configure `tavily.search()`, `exa.search()`, or `brave.search()` for search; Atlas does not map Z.ai's web-search API to an AI SDK native search tool.

**Concurrency:** `concurrency: { models: 8, io: 10 }` or `ATLAS_MODEL_CONCURRENCY` / `ATLAS_IO_CONCURRENCY`.

## Stream it

```ts
const run = atlas.start(question, { effort: "balanced" });

let preview = "";
for await (const e of run.events()) {
  if (e.type === "report.reset") preview = "";
  if (e.type === "report.delta") preview += e.text;
  if (e.type === "source.fetched") console.error(e.url);
}

const result = await run.result();
```

`report.delta` carries the working draft as it is written and revised; `report.reset` precedes each rewrite, so clear your preview buffer on it. `report.completed` (and `result.report`) is canonical after citation binding. `run.stop()` synthesizes from whatever's gathered so far; `run.cancel()` aborts. Late subscribers get full event history.

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
result.note; // short note on how the research was approached
result.citations; // sentence-bound citations (single-spine runs; empty for orchestrated runs)
result.unsupportedSentences; // report sentences that failed citation binding
result.warnings; // non-fatal issues (e.g. a researcher that returned nothing)
result.sources; // sources, tagged by researcher
result.stats; // cost, tokens, duration, …
result.trace; // timing/cost trace + bottleneck digest when trace !== "off" (single-spine runs)
```

## Structured output

Pass a `schema` to get a typed object extracted from the finished report, returned alongside the full result. It runs as a final pass over the report, so it works on any path — single spine run, orchestrated fleet, or an outsourced researcher.

```ts
import { z } from "zod";

const r = await atlas.research("Acme's latest annual revenue and CEO?", {
  schema: z.object({ revenue: z.string(), ceo: z.string() }),
});

r.object; // typed: { revenue: string; ceo: string }
r.report; // the cited report it was extracted from
```

## Budget

One meter for everything. Pick an effort, or override any cap with `budget`.

| effort     | ~budget | sources | tokens |
| ---------- | ------- | ------- | ------ |
| `fast`     | $0.50   | 15      | 5M     |
| `balanced` | $2.50   | 40      | 20M    |
| `deep`     | $10     | 100     | 80M    |
| `max`      | $40     | 250     | 250M   |

```ts
await atlas.research(question, {
  effort: "deep",
  budget: { maxUSD: 5, maxTokens: 50_000_000 },
});
```

`maxUSD` is a **best-effort target, not a hard ceiling.** The meter checks between agent turns, so a run stops _starting_ work once spent, but in-flight calls (up to `concurrency.models`) can overshoot. Pricing comes from a built-in table that can lag provider changes — pass `pricing` to correct a rate when the cap must be accurate.

The real backstops are **price-independent** — each defaults to the effort row above and is enforced regardless of prices:

- `budget.maxTokens` — input + output tokens run-wide (cache reads excluded). Checked between turns like `maxUSD`, but never drifts with prices.
- `budget.maxSources`, `budget.maxDurationMs` — fetched-source and wall-clock caps.

`result.stats` reports `budgetExhausted` and `tokensExhausted` so you can see which limit bound the run. Leave headroom on `maxUSD`, or set a provider-side spend limit, when the cap is truly hard.

`result.stats.stopReason` folds those into one value — `"completed"`, `"stopped"` (`run.stop()`), or a binding cap (`"budget"`, `"tokens"`, `"timeout"`). When several apply, the most proximate wins.

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
