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

npx @steel-dev/atlas "What are the strongest deep research framework?"
```

Get keys from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com), plus [Steel](https://app.steel.dev).

## CLI

```bash
atlas "What's the state of the art in single-image novel view synthesis?"
atlas "..." > report.md
atlas "..." --out report.md
atlas "..." --provider openai --model gpt-5.5
atlas "..." --provider openai --base-url https://your-openai-compatible-endpoint/v1
atlas "..." --proxy
```

Run `atlas --help` for the full option list.

## TypeScript

```ts
import { research } from "@steel-dev/atlas";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
  provider: "openai",
  model: "gpt-5.5",
  useProxy: true,
});

console.log(result.markdown);
console.log(result.citedSources); // sources Atlas fetched and the report cited (provenance)
console.log(result.citationsNotFetched); // cited URLs Atlas did not fetch
```

Atlas supports Anthropic and OpenAI-compatible chat completions through a thin internal model adapter. The research loop stays the same: models can call `search` and `fetch`, then Atlas applies runtime limits, source tracking, and citation reconciliation.

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
