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

## Development

```bash
npm install
npm run dev -- "your question"
npm run test
npm run build
```

## License

MIT.
