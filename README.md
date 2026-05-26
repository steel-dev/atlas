# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

**Deep research that just works.**

```bash
npx @steel-dev/atlas "What is deep research?" > report.md
```

Ask a messy question. Atlas searches the web, fetches regular pages directly, falls back to a real browser when needed, follows the useful trails, and writes a cited Markdown report.

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export STEEL_API_KEY=sk_...

npx @steel-dev/atlas "What are the strongest deep research framework?"
```

Get keys from [Anthropic](https://console.anthropic.com) and [Steel](https://app.steel.dev).

## CLI

```bash
atlas "What's the state of the art in single-image novel view synthesis?"
atlas "..." > report.md
atlas "..." --out report.md
atlas "..." --effort max
```

Progress goes to stderr. The report goes to stdout, so it pipes cleanly into files, scripts, or your next prompt.

Run `atlas --help` for the full option list.

## TypeScript

```ts
import { research } from "@steel-dev/atlas";

const result = await research({
  query: "What's changing in browser automation for AI agents?",
});

console.log(result.markdown);
console.log(result.sources);
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
