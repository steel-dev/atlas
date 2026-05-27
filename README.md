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
atlas "..." --effort max
atlas "..." --provider openai --model gpt-5.5
atlas "..." --provider openai --base-url https://your-openai-compatible-endpoint/v1
atlas "..." --proxy
```

Progress goes to stderr. The report goes to stdout, so it pipes cleanly into files, scripts, or your next prompt.

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
console.log(result.verifiedSources); // URLs Atlas fetched and the report cited
console.log(result.unverifiedCitations); // cited URLs Atlas did not fetch
```

Atlas can also return a structured payload after the research is complete:

```ts
const result = await research({
  query: "Which company matches these clues?",
  output: {
    schema: {
      type: "object",
      properties: {
        final_answer: {
          type: "string",
          description: "Concise exact answer.",
        },
        evidence: {
          type: "array",
          description: "Fetched-source evidence supporting the answer.",
          items: {
            type: "object",
            properties: {
              clue: { type: "string" },
              source_url: { type: "string" },
              quote: { type: "string" },
            },
            required: ["clue", "source_url", "quote"],
            additionalProperties: false,
          },
        },
      },
      required: ["final_answer", "evidence"],
      additionalProperties: false,
    },
  },
});

console.log(result.structured);
```

Atlas supports Anthropic and OpenAI-compatible chat completions through a thin internal model adapter. The research loop stays the same: models can call `search` and `fetch`, then Atlas applies runtime limits, source tracking, and citation auditing.

## Development

```bash
npm install
npm run dev -- "your question"
npm run test
npm run build
```

## License

MIT.
