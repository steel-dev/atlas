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
# or:
# export ATLAS_PROVIDER=openai
# export OPENAI_API_KEY=sk-...
export STEEL_API_KEY=sk_...

npx @steel-dev/atlas "What is the strongest deep research framework?"
```

Get keys from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com), plus [Steel](https://app.steel.dev).

## CLI

```bash
atlas "What's the state of the art in single-image novel view synthesis?"
atlas "..." > report.md
atlas "..." --out report.md
atlas "..." --provider openai --model gpt-5.5
atlas "..." --provider openai --base-url https://your-openai-compatible-endpoint/v1
atlas "..." --search-provider exa
atlas "..." --team 4                 # allow up to 4 parallel sub-agents
atlas "..." --token-limit 5000000    # raise the test-time compute budget (0 = unlimited)
atlas "..." --timeout 300            # wall-clock budget in seconds
atlas "..." --proxy
atlas "..." --json 2> events.jsonl   # one JSON progress event per line on stderr
atlas "..." --quiet                  # suppress progress output
```

Run `atlas --help` for the full option list.

## TypeScript

```ts
import { research, openai } from "@steel-dev/atlas";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
  model: openai("gpt-5.5"), // openai + anthropic are re-exported for convenience
  useProxy: true,
});

console.log(result.markdown);
console.log(result.citedSources); // sources Atlas fetched and the report cited (provenance)
console.log(result.citationsNotFetched); // cited URLs Atlas did not fetch
```

## Bring any model

Atlas runs every model through the [Vercel AI SDK](https://ai-sdk.dev), so the research loop stays the same — models call `search` and `fetch`, then Atlas applies runtime limits, source tracking, and citation reconciliation — while you can reach any provider the AI SDK supports.

`model` is a Vercel AI SDK `LanguageModel`. `openai` and `anthropic` are re-exported from this package, so the built-ins need no extra install; for any other provider, install its `@ai-sdk/*` package and pass that model:

```ts
import { research } from "@steel-dev/atlas";
import { google } from "@ai-sdk/google";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
  model: google("gemini-3-pro"), // or bedrock(...), vertex(...), groq(...), …
});
```

Bring your own key with the provider factory (`createOpenAI({ apiKey, baseURL })`, also re-exported) or the provider's standard env var. Atlas preserves provider-native capability through the same loop: Anthropic thinking signatures and OpenAI reasoning round-trip across tool turns, prompt caching stays on, and `ATLAS_THINKING_EFFORT` maps to each provider's effort knob. The CLI keeps the string flags (`--provider`, `--model`, `--base-url`).

## Search backends

The search tool runs behind a pluggable `SearchProvider`. The default (`web`) scrapes DuckDuckGo/Bing/Google through Steel Browser; `exa` and `brave` use those search APIs directly.

```bash
atlas "..." --search-provider exa     # ATLAS_EXA_API_KEY or EXA_API_KEY
atlas "..." --search-provider brave   # ATLAS_BRAVE_API_KEY or BRAVE_API_KEY
# or: export ATLAS_SEARCH_PROVIDER=exa
```

Bring your own backend by passing a `SearchProvider` instance — give a query, return ranked results, and Atlas handles batching, RRF merging, caching, and citation reconciliation:

```ts
import {
  research,
  createExaSearchProvider,
  type SearchProvider,
} from "@steel-dev/atlas";

await research({
  query: "What's changing in browser automation for AI agents?",
  searchProvider: createExaSearchProvider({ apiKey: process.env.EXA_API_KEY! }),
});

const custom: SearchProvider = {
  name: "internal-index",
  async searchQuery({ query, limit, signal }) {
    const hits = await myIndex.search(query, { limit, signal });
    return {
      query,
      sources: [{ source: "internal-index", order: 0, results: hits }],
      attempted: ["internal-index"],
      warnings: [],
      sawEmptyResults: hits.length === 0,
    };
  },
};
await research({ query: "...", searchProvider: custom });
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
