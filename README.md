# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research that just works.**

```bash
npx @steel-dev/atlas "What is deep research?" > report.md
```

Ask a messy question. Atlas scopes it into search angles, fetches pages through Steel Browser, extracts verbatim-quoted claims, chases the gaps, adversarially verifies every claim, and writes a cited Markdown report from the survivors.

## Quick Start (CLI)

Set API keys, then run:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# export OPENAI_API_KEY=sk-...
export STEEL_API_KEY=sk_...

npx @steel-dev/atlas "What is the strongest deep research framework?" > report.md
```

Get keys from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com), plus [Steel](https://app.steel.dev).

## Install

For programmatic use, install the package, the AI SDK core, and whichever model provider you plan to import:

```bash
npm install @steel-dev/atlas ai @ai-sdk/anthropic
# npm install @ai-sdk/openai   # if you use OpenAI
# npm install @ai-sdk/google   # if you use Google, etc.
```

## Usage

```ts
import { Atlas } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const atlas = new Atlas({ model: anthropic("claude-sonnet-4-6") });

const result = await atlas.research(
  "What's changing in browser automation for AI agents?",
);

console.log(result.markdown);
console.log(result.citedSources);
console.log(result.claims.confirmed); // verified claims, with quotes and votes
console.log(result.stats); // angles, sources, claims extracted/verified, surveys
```

## How it works

Every run goes through one fixed lifecycle, so the report rests on verified evidence rather than whatever happened to stay in context:

1. **Scope** — decompose the question into complementary search angles (1 for a narrow lookup, up to 6 for a broad one).
2. **Recall** — search every angle, dedupe URLs, fetch the top sources, and extract falsifiable claims, each pinned to a verbatim quote that is string-matched against the stored source text.
3. **Gap-chasing** — a lead agent reads the claim ledger and closes what's missing with `survey` (search + fetch + extract in one call), direct `fetch`, or interactive `browser_*` tools. It never re-derives what the ledger already covers.
4. **Verify** — each claim faces an independent adversarial panel (quote fidelity, two contradiction searches, source strength). Two refutations kill it; too few votes leave it unverified.
5. **Synthesize** — write a cited report from the confirmed claims, drawing on the strongest unconfirmed candidates when confirmed evidence is thin; weak or unverified support lowers confidence and surfaces as caveats and open questions rather than being silently dropped.

`result.claims` partitions every claim into `confirmed` / `refuted` / `unverified`, and `result.stats` reports the run shape (angles, sources fetched, claims extracted/verified, surveys, re-anchors).

## Streaming

`atlas.research()` resolves once, at the end. For a live UI, `atlas.stream()` returns a handle you can iterate while the run is in flight; its promise fields still resolve at the end whether or not you read the stream.

```ts
import { Atlas } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const atlas = new Atlas({ model: anthropic("claude-sonnet-4-6") });

const run = atlas.stream(
  "What's changing in browser automation for AI agents?",
);

for await (const part of run.fullStream) {
  if (part.type === "fetching") process.stderr.write(`reading ${part.url}\n`);
  else if (part.type === "claim_verified")
    process.stderr.write(`${part.status}: ${part.claim}\n`);
  else if (part.type === "report_delta") process.stdout.write(part.text);
}

const { citedSources } = await run.result;
```

Prefer callbacks to iteration? The same handle is a typed event emitter: `run.on(type, listener)` is keyed by event type — the listener argument is narrowed to that event — returns an unsubscribe function, and `once` / `off` work as expected.

```ts
const run = atlas.stream(
  "What's changing in browser automation for AI agents?",
);

const off = run.on("fetching", (e) => process.stderr.write(`reading ${e.url}\n`));
run.on("claim_verified", (e) =>
  process.stderr.write(`${e.status}: ${e.claim}\n`),
);
run.on("report_delta", (e) => process.stdout.write(e.text));

const { citedSources } = await run.result;
off();
```

## Structured output

Pass an `outputSchema` to get typed data alongside the Markdown report. The schema is a [Zod](https://zod.dev) schema or an AI SDK `jsonSchema()` — anything the AI SDK accepts. `result.data` is the typed object, filled from the verified claims; `result.basis` maps each field path to the source citations (with the exact quote excerpt) and reasoning that back it, so every cell is auditable. Fields no claim supports are flagged transparently rather than invented.

```ts
import { Atlas } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const atlas = new Atlas({ model: anthropic("claude-sonnet-4-6") });

const result = await atlas.research({
  query: "Compare the top deep-research frameworks on license and language.",
  outputSchema: z.object({
    frameworks: z.array(
      z.object({
        name: z.string(),
        license: z.string(),
        language: z.string(),
      }),
    ),
  }),
});

result.data.frameworks.forEach((f) => console.log(f.name, f.license));

// every field is grounded — basis is keyed by field path:
console.log(result.basis["frameworks.0.license"].citations);
```

The Markdown report is still produced, so `result.markdown` and `result.citedSources` are there too.

## Custom tools

Give the model domain-specific tools alongside the built-ins. Anything a tool registers via `ctx.addSource` becomes a citable source — its content is extracted into claims, adversarially verified, and cited in the report exactly like a fetched web page. This is the extension point for verticals: plug in PubMed, Westlaw, an internal API, or a vector store.

```ts
import { Atlas, researchTool } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const atlas = new Atlas({
  model: anthropic("claude-sonnet-4-6"),
  tools: {
    pubmedSearch: researchTool({
      description: "Search PubMed for peer-reviewed studies. Each result becomes a citable source.",
      inputSchema: z.object({ query: z.string(), limit: z.number().default(5) }),
      execute: async ({ query, limit }, ctx) => {
        const studies = await pubmed.search(query, { limit, signal: ctx.signal });
        for (const s of studies) {
          ctx.addSource({ url: s.url, title: s.title, content: s.abstract });
        }
        return studies.map((s) => `- ${s.title} — ${s.url}`).join("\n");
      },
    }),
  },
});

const { markdown } = await atlas.research("Evidence for SGLT2 inhibitors in HFpEF?");
```

The tool key (`pubmedSearch`) is the name the model calls. `inputSchema` is a Zod schema or AI SDK `jsonSchema()`. The `ctx` passed to `execute` carries `addSource({ url, title, content })`, an `AbortSignal` as `ctx.signal`, and `ctx.log(message)` for progress.

## Bring any model

Atlas runs every model through the [Vercel AI SDK](https://ai-sdk.dev), so the lifecycle stays the same across providers — recall, gap-chasing, verification, and synthesis — while you reach any provider the AI SDK supports. Install the provider package you need (`@ai-sdk/google`, `@ai-sdk/openai`, …). The lead and the leaf agents (claim extraction, verification voters) can run different models; pass `leafModel` to route the high-volume leaf calls to a cheaper model.

```ts
import { Atlas } from "@steel-dev/atlas";
import { google } from "@ai-sdk/google";

const atlas = new Atlas({
  model: google("gemini-3-pro"), // or bedrock(...), vertex(...), groq(...), …
});

const result = await atlas.research(
  "What's changing in browser automation for AI agents?",
);
```

## Search and browser

Atlas fetches every page and, by default, scrapes search-engine results through a browser substrate. Steel reads `STEEL_API_KEY` from the environment, so you can omit `browser: steel()` unless you want to override a knob. Pass `browser` and `search` only to customize behavior or swap the search backend.

```ts
import { Atlas, steel, exa } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const atlas = new Atlas({
  model: anthropic("claude-sonnet-4-6"),
  browser: steel({ proxy: true }),
  search: exa(), // bypass the browser for search; omit to scrape SERPs
});

const result = await atlas.research(
  "What's changing in browser automation for AI agents?",
);
```

## Development

Clone and work on the repo (not required to use the published package):

```bash
git clone https://github.com/steel-experiments/atlas.git
cd atlas
npm install
npm run dev -- "your question"
npm run test
npm run build
```

## License

MIT.
