# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research that just works.**

```bash
npx @steel-dev/atlas "What is deep research?" > report.md
```

Ask a messy question. Atlas searches the web, fetches pages through Steel Browser, follows the useful trails, and writes a cited Markdown report.

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export STEEL_API_KEY=sk_...

npx @steel-dev/atlas "What is the strongest deep research framework?"
```

Get keys from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com), plus [Steel](https://app.steel.dev).

## Usage

```ts
import { research } from "@steel-dev/atlas";
import { openai } from "@ai-sdk/openai";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
  model: openai("gpt-5.5"),
});

console.log(result.markdown);
console.log(result.citedSources); // sources Atlas fetched and the report cited (provenance)
```

## Streaming

`research()` resolves once, at the end. For a live UI, `streamResearch()` returns a handle you can iterate while the run is in flight; its promise fields still resolve at the end whether or not you read the stream.

```ts
import { streamResearch } from "@steel-dev/atlas";
import { openai } from "@ai-sdk/openai";

const run = streamResearch({
  query: "What's changing in browser automation for AI agents?",
  model: openai("gpt-5.5"),
});

for await (const part of run.fullStream) {
  if (part.type === "fetching") process.stderr.write(`reading ${part.url}\n`);
  else if (part.type === "report_delta") process.stdout.write(part.text);
}

const { citedSources } = await run.result;
```

## Bring any model

Atlas runs every model through the [Vercel AI SDK](https://ai-sdk.dev), so the research loop stays the same — models call `search` and `fetch`, then Atlas applies runtime limits, source tracking, and citation reconciliation, while you can reach any provider the AI SDK supports.

```ts
import { research } from "@steel-dev/atlas";
import { google } from "@ai-sdk/google";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
  model: google("gemini-3-pro"), // or bedrock(...), vertex(...), groq(...), …
});
```

## Search and browser

Atlas fetches every page and, by default, scrapes search-engine results through a browser substrate. Steel reads its config from the environment, so the zero-config path needs nothing; reach for `browser` and `search` only to override a knob or swap the search backend.

```ts
import { research, steel, exa } from "@steel-dev/atlas";
import { openai } from "@ai-sdk/openai";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
  model: openai("gpt-5.5"),
  browser: steel({ proxy: true }),
  search: exa(), // bypass the browser for search; omit to scrape SERPs
});
```

## Reusable researchers

Define a researcher once — model, domain behavior, and defaults — then reuse it across many queries. This fits long-lived processes such as a server handling many requests: resources are created lazily on the first query, and concurrent runs stay isolated. Pass the query positionally; everything else is bound.

```ts
import { createResearcher } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const researcher = createResearcher({
  model: anthropic("claude-sonnet-4-6"),
  instructions:
    "You are a clinical evidence analyst. Prefer RCTs and meta-analyses.",
  defaults: { timeoutMs: 180_000, suggestedTeamSize: 3 },
});

const result = await researcher.research("SGLT2 inhibitors for HFpEF?");

const run = researcher.stream("GLP-1 agonists and cardiovascular outcomes?");
for await (const part of run.fullStream) {
  if (part.type === "report_delta") process.stdout.write(part.text);
}

await researcher.close(); // drains in-flight runs; or `await using researcher = createResearcher({ … })`
```

`instructions` is appended to the system prompt rather than replacing it, and `defaults` set per-call options you can still override on each `research()` / `stream()` call. One-shot `research()` and `streamResearch()` calls accept `instructions` too.

## Custom tools

Give the model domain-specific tools alongside the built-ins. `researchTool` takes an `inputSchema` (Zod, or any AI SDK schema) and an `execute`; anything you register with `ctx.addSource` becomes a citable source in the report, exactly like a fetched page.

```ts
import { createResearcher, researchTool } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const researcher = createResearcher({
  model: anthropic("claude-sonnet-4-6"),
  tools: {
    pubmedSearch: researchTool({
      description:
        "Search PubMed for peer-reviewed studies. Each result becomes a citable source.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().default(5),
      }),
      execute: async ({ query, limit }, ctx) => {
        const studies = await pubmed.search(query, {
          limit,
          signal: ctx.signal,
        });
        for (const s of studies) {
          ctx.addSource({ url: s.url, title: s.title, content: s.abstract });
        }
        return studies.map((s) => `- ${s.title} — ${s.url}`).join("\n");
      },
    }),
  },
});

const { markdown } = await researcher.research(
  "Evidence for SGLT2 inhibitors in HFpEF?",
);
```

## Development

```bash
npm install
npm run dev -- "your question"
npm run test
npm run build
```

## License

MIT.
