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

## Development

```bash
npm install
npm run dev -- "your question"
npm run test
npm run build
```

## License

MIT.
