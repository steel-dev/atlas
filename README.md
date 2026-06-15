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
        for (const s of studies)
          ctx.addSource({ url: s.url, title: s.title, content: s.abstract });
        return studies.map((s) => `- ${s.title}`).join("\n");
      },
    }),
  },
});
```

**Models per role:** override `models.extract` / `models.verify` (defaults to a small sibling for Anthropic/OpenAI when keys are present). Screening and entailment checks always run on `models.verify`; at `deep`/`max` the adversarial panel escalates to the lead model with more turns per verifier.

**Concurrency:** `concurrency: { models: 8, io: 10 }` or `ATLAS_MODEL_CONCURRENCY` / `ATLAS_IO_CONCURRENCY`.

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
result.citations; // spans + quotes + verification
result.claims.confirmed; // passed full panel
result.claims.screened; // cheap check only
result.claims.contested; // sources disagree, surfaced
result.structured; // typed output (optional)
result.stats; // cost, tokens, agents spawned, …
```

Structured output: pass a Zod schema via `output: { kind: "structured", schema }`. Per-field citations land in `result.structuredBasis`.

## Budget

One meter for everything. Pick an effort, or override any cap with `budget`.

| effort     | ~budget | depth | spawns/turn | sources | agents | tokens |
| ---------- | ------- | ----- | ----------- | ------- | ------ | ------ |
| `fast`     | $0.50   | 1     | 1           | 15      | 20     | 5M     |
| `balanced` | $2.50   | 2     | 4           | 40      | 80     | 20M    |
| `deep`     | $10     | 3     | 8           | 100     | 250    | 80M    |
| `max`      | $40     | 4     | 12          | 250     | 800    | 250M   |

```ts
await atlas.research(question, {
  effort: "deep",
  budget: { maxUSD: 5, maxTokens: 50_000_000, maxAgents: 100 },
});
```

`maxUSD` is a **best-effort target, not a hard ceiling.** Cost is metered per model call against a built-in pricing table, and the budget is checked between agent turns: a run stops *starting* new work once the meter is spent, but can still overshoot. In-flight calls (up to `concurrency.models` at a time) are billed at their actual cost only after they return, so the dollar figure is a typical total, not a guarantee. The table also goes stale when a provider changes prices, and unknown models are costed conservatively — pass `pricing` to correct a model's rate when the dollar cap must be accurate.

Because the dollar cap rides on those prices, the real backstops are **price-independent.** Each defaults to the effort row above and is enforced regardless of what prices say:

- `budget.maxTokens` — input + output tokens run-wide (cache reads excluded, since they re-read already-counted text). Like `maxUSD` it is checked between agent turns, so in-flight calls can push the total slightly past the cap; unlike `maxUSD` it never drifts with provider prices.
- `budget.maxAgents` — research subagents spawned run-wide (the recursive fan-out that can otherwise grow as breadth^depth). Enforced synchronously, with no overshoot: once it is reached, further `spawn` calls are refused and the lead finishes inline. Verifier agents are bounded separately and count toward `maxTokens`, not this cap.
- `budget.maxSources`, `budget.maxDurationMs` — fetched-source and wall-clock caps.

`result.stats` reports `budgetExhausted`, `tokensExhausted`, and `agentCapReached` so you can see which limit, if any, bound the run — `agentCapReached` is set only when the cap actually refused a spawn, not merely when the count was reached. Leave headroom on `maxUSD`, or set a provider-side spend limit, when the cap is truly hard.

## Safety

Untrusted web content is quarantined (data, not instructions). Fetches pass SSRF guards hop-by-hop; `run_code` runs in a memory-capped V8 isolate with no network, filesystem, or host access. Direct fetch honors robots.txt.

The isolate is provided by the optional `isolated-vm` dependency. If it isn't installed (or failed to build on your platform), `run_code` is omitted from the agents' toolset and the run proceeds without it — Atlas never falls back to an unsandboxed evaluator.

The SSRF guard validates each hostname's DNS resolution at check time but cannot pin the subsequent connection to the validated address, so an attacker controlling DNS can defeat it via rebinding. Treat it as defense-in-depth: when researching potentially hostile targets, run Atlas behind network-level egress controls that block private ranges.

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
