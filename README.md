# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**A model-agnostic deep-research engine: one question in, a verified, cited report out.**

```ts
import { Atlas } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const atlas = new Atlas({ model: anthropic("claude-fable-5") });
const result = await atlas.research(
  "What's changing in browser automation for AI agents?",
);

console.log(result.report);
```

The whole engine is one recursive primitive, one shared budget, one shared ledger, and one final binding pass. A lead agent holds a `spawn` tool; whether a run stays single-agent or fans out into an orchestrator with research and verify subagents is never configured — it emerges from the lead's spawn decisions under a tree-shared USD budget. Subagents isolate their reasoning context but write verbatim-quoted claims to one shared ledger; every quote is mechanically string-checked against the stored page text, and a final citation-binding pass checks the drafted report sentence by sentence before you see it.

## Install

```bash
npm install @steel-dev/atlas ai @ai-sdk/anthropic
# or @ai-sdk/openai / @ai-sdk/google — any AI SDK 6 LanguageModel works
```

## How a run works

1. **Plan** — the lead agent states its approach (answer inline / spawn k workers on these facets). Emitted as a `plan.updated` event.
2. **Act** — it either researches directly (search, fetch, read stored sources, sandboxed code over source text) or spawns research subagents, each with a private context and a slice of the shared budget. Every fetched page has falsifiable claims extracted into the shared ledger, each carrying a verbatim quote that is string-checked against the stored text; agents can also mint claims directly with `add_claim` when they pin a value extraction missed — under the same verbatim-quote check.
3. **Integrate & verify** — the lead reads returned notes, new claims, and the ledger digest, fills gaps with follow-up spawns, and spends budget on verify subagents. Verification is staged: central claims get the full adversarial panel (quote-fidelity, contradiction, and source-strength lenses vote; a refutation quorum kills a claim, a single refutation marks it contested) and are checked eagerly as they appear; other claims get a cheap screening check that escalates to the panel only when flagged. When the remaining grant cannot fund a panel, central claims fall back to the screening check instead of starving a panel mid-vote. Before the final sweep, semantically duplicate claims are merged into corroboration and claims that contradict each other are flagged contested — contradicted claims always escalate to the full panel, with the rival claim in the verifier's prompt.
4. **Synthesize & bind** — the writer drafts the report with inline claim markers, consulting the stored sources (passage search, exact reads, sandboxed code) for precise wording and figures; the binding pass re-checks every cited sentence against its claim, quote, and surrounding source text, emits `citations[]` with character spans, flags uncited factual sentences, and runs a repair pass that rewrites or drops whatever failed.

```
fast question  → lead answers inline; one search, one fetch; single-agent emerged
broad survey   → lead fans out research subagents, verifies central claims; orchestrator emerged
```

## Budget is the only knob

Effort tiers set the envelope; `budget.maxUSD` is a hard ceiling. Spawning, searching, fetching, extraction, verification, and synthesis all draw from one meter. When it runs low, spawns are refused and the lead finishes inline; whatever the ledger holds is still synthesized and bound.

| effort | budget | spawn depth | spawns/turn |
|---|---|---|---|
| `fast` | ~$0.50 | 1 | 1 |
| `balanced` | ~$2.50 | 2 | 4 |
| `deep` | ~$10 | 3 | 8 |
| `max` | ~$40 | 4 | 12 |

```ts
await atlas.research(question, { effort: "deep", budget: { maxUSD: 5 } });
```

## Streaming and the run handle

```ts
const run = atlas.start(question, { effort: "balanced" });

for await (const event of run.events()) {
  if (event.type === "plan.updated") console.error(`plan: ${event.rationale}`);
  if (event.type === "agent.spawned")
    console.error(`spawned ${event.role} ($${event.grantUSD.toFixed(2)})`);
  if (event.type === "claim.verified")
    console.error(`${event.status} ${event.claimId} (${event.votes})`);
  if (event.type === "report.delta") process.stdout.write(event.text);
}

const result = await run.result();
```

The handle also exposes `run.stop()` — end research early but still synthesize, bind, and return a report from whatever the ledger holds — and `run.cancel()`, which aborts outright. Late subscribers to `run.events()` receive the full event history first, so a UI can attach at any point.

Events are a versioned, JSON-serializable union: `run.started`, `plan.updated`, `agent.spawned`, `agent.returned`, `search.completed`, `source.fetched`, `claim.extracted`, `claim.verified`, `report.delta`, `citation.bound`, `budget.warning`, `safety.flag`, `run.completed`, `run.error`, and more — enough for a UI to render full progress from the stream alone.

## Results

```ts
result.report                 // cited markdown
result.citations              // [{ sentenceSpan, claimId, sourceId, quote, verified }]
result.claims.confirmed       // survived adversarial verification
result.claims.contested       // sources disagree — surfaced, not buried
result.findings               // statements with confidence + claim/source ids
result.openQuestions
result.stats                  // costUSD, tokens per role, agentsSpawned, maxDepth,
                              // singleAgent, citationsBound, citationsUnsupported, …
```

## Structured output

```ts
import { z } from "zod";

const result = await atlas.research(
  "Compare the top deep-research frameworks on license and language.",
  {
    output: {
      kind: "structured",
      schema: z.object({
        frameworks: z.array(
          z.object({ name: z.string(), license: z.string(), language: z.string() }),
        ),
      }),
    },
  },
);

result.structured;                                  // the typed object
result.structuredBasis?.["frameworks.0.license"];   // citations + reasoning per field path
```

## Durability: journal, resume, pause

Every model call is journaled with a call key. Give Atlas a persistent store and a run can be resumed after a crash, deploy, or `pause()` — completed calls replay from the journal at zero cost; the first divergence runs live.

```ts
import { Atlas, fileStore } from "@steel-dev/atlas";

const store = fileStore("./runs");
const atlas = new Atlas({ model, store });
const run = atlas.start(question, { runId: "run_brief_42" });
// …process restarts…
const resumed = await Atlas.resume("run_brief_42", { model, store });
```

## Search and fetch providers

Search is pluggable: `tavily()`, `exa()`, `brave()` adapters (plain REST, picked up automatically from `TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_API_KEY`), or the model provider's native server-side search when no key is configured.

Fetching is a chain: `basicFetch()` (plain HTTP + readability + PDF extraction) is the free default; `steel()` escalates JS-rendered, anti-bot, and blocked pages through [Steel](https://steel.dev) sessions and is added automatically when `STEEL_API_KEY` is set.

```ts
import { Atlas, exa, steel, basicFetch } from "@steel-dev/atlas";
const atlas = new Atlas({
  model,
  search: exa(),
  fetch: [basicFetch(), steel({ proxy: true })],
});
```

## Models per role

Quality scales with the model; cost scales with where you spend it. Extraction and verification are the highest-volume roles, so when `models.extract`/`models.verify` are not set and the lead model is an Anthropic or OpenAI model whose API key is in the environment, Atlas defaults those roles to a small sibling (`claude-haiku-4-5` / `gpt-5-mini`). Override roles independently to take full control:

```ts
const atlas = new Atlas({
  model: anthropic("claude-fable-5"),
  models: {
    extract: anthropic("claude-haiku-4-5"),
    verify: anthropic("claude-sonnet-4-6"),
  },
});
```

## Custom tools

Give research agents domain sources; anything a tool adds via `addSource` becomes a citable source and flows through the same ledger and verification machinery. This is the extension point for verticals: PubMed, EDGAR, an internal API, a vector store.

```ts
import { Atlas, researchTool } from "@steel-dev/atlas";
import { z } from "zod";

const atlas = new Atlas({
  model,
  tools: {
    pubmed_search: researchTool({
      description: "Search PubMed for peer-reviewed studies.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }, ctx) => {
        const studies = await pubmed.search(query, { signal: ctx.signal });
        for (const s of studies) {
          ctx.addSource({ url: s.url, title: s.title, content: s.abstract });
        }
        return studies.map((s) => `- ${s.title} — ${s.url}`).join("\n");
      },
    }),
  },
});
```

## Safety

Atlas feeds untrusted web content to models in a tool loop, and the harness carries defenses accordingly: fetched content is quarantined in provenance-tagged delimiters and treated as data, never instructions; agents that consume fetched content hold read-only tools by construction; every outbound fetch passes an SSRF guard (scheme allowlist, private-IP block after DNS resolution, credential/length checks, an entropy heuristic against URL-based exfiltration on never-seen domains); and `run_code` executes in an isolated subprocess with no filesystem, network, or process access. Robots.txt handling and per-domain politeness are not yet implemented.

## Examples and evals

- `examples/cli.ts` — terminal research runs (`npm run dev -- "question"`).
- `examples/serve.ts` — minimal SSE web app.
- `evals/` — BrowseComp and DRACO-style harnesses (`npm run eval:browsecomp`, `npm run eval:draco`); these gate releases.

## Development

```bash
git clone https://github.com/steel-experiments/atlas.git
cd atlas
npm install
npm run dev -- "your question"
npm run test
npm run build
```

## License

MIT
