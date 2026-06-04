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
import { Researcher } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const researcher = new Researcher({ model: anthropic("claude-sonnet-4-6") });

const result = await researcher.research(
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
5. **Synthesize** — the report is written only from confirmed claims, each cited to its source URL.

`result.claims` partitions every claim into `confirmed` / `refuted` / `unverified`, and `result.stats` reports the run shape (angles, sources fetched, claims extracted/verified, surveys, re-anchors).

## Streaming

`researcher.research()` resolves once, at the end. For a live UI, `researcher.stream()` returns a handle you can iterate while the run is in flight; its promise fields still resolve at the end whether or not you read the stream.

```ts
import { Researcher } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const researcher = new Researcher({ model: anthropic("claude-sonnet-4-6") });

const run = researcher.stream(
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

## Bring any model

Atlas runs every model through the [Vercel AI SDK](https://ai-sdk.dev), so the lifecycle stays the same across providers — recall, gap-chasing, verification, and synthesis — while you reach any provider the AI SDK supports. Install the provider package you need (`@ai-sdk/google`, `@ai-sdk/openai`, …). The lead and the leaf agents (claim extraction, verification voters) can run different models; pass `leafModel` to route the high-volume leaf calls to a cheaper model.

```ts
import { Researcher } from "@steel-dev/atlas";
import { google } from "@ai-sdk/google";

const researcher = new Researcher({
  model: google("gemini-3-pro"), // or bedrock(...), vertex(...), groq(...), …
});

const result = await researcher.research(
  "What's changing in browser automation for AI agents?",
);
```

## Search and browser

Atlas fetches every page and, by default, scrapes search-engine results through a browser substrate. Steel reads `STEEL_API_KEY` from the environment, so you can omit `browser: steel()` unless you want to override a knob. Pass `browser` and `search` only to customize behavior or swap the search backend.

```ts
import { Researcher, steel, exa } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const researcher = new Researcher({
  model: anthropic("claude-sonnet-4-6"),
  browser: steel({ proxy: true }),
  search: exa(), // bypass the browser for search; omit to scrape SERPs
});

const result = await researcher.research(
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
