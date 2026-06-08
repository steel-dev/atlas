---
name: atlas-build-researcher
description:
  Scaffold a domain-specific deep-research agent on the Atlas SDK. Use when the user
  wants to build or customize a research agent for a domain — medical, legal, financial,
  an internal API, a vector store — on top of @steel-dev/atlas, e.g. "build a research
  agent for X", "add a PubMed source to atlas", "make atlas search our internal docs".
  Generates a small module (instructions + domain tools + optional output schema) and
  smoke-tests it. Do NOT use to run a one-off query — that's atlas-research.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash
---

# atlas-build-researcher

Scaffold a domain-specific deep-research agent on top of Atlas. The output is a
small, owned module the user keeps in their repo — not a fork of Atlas. The
verification engine and the data contract stay in the package, untouched.

A custom researcher is just configuration: `new Atlas({ model, instructions, tools })`,
optionally with an `outputSchema` per run. Anything a tool passes to
`ctx.addSource` becomes a citable source that flows through the same extraction,
adversarial verification, and citation pipeline as a fetched web page.

## Step 1 — Load the current API

Read the agent brief so the generated code matches the installed version, not
memory:

```bash
atlas docs 2>/dev/null || cat llms.txt 2>/dev/null || cat node_modules/@steel-dev/atlas/llms.txt 2>/dev/null
```

If none resolve, Read `README.md` from the package instead. Never guess the API
surface — `instructions`, `tools` (a record), `researchTool`, and `ctx.addSource`
are the load-bearing pieces.

## Step 2 — Interview (only what's missing)

Ask the user, skipping anything they already stated:

1. **Domain & angle** — what field, and what should the lead prioritize? (Becomes
   `instructions`.)
2. **Sources** — which APIs / databases / stores back this researcher? For each:
   endpoint, auth (env var name — never a pasted key), and what a "result" is.
3. **Structured output?** — do they want typed data (`outputSchema`) alongside the
   Markdown, or just the report?
4. **Model** — provider/model, and whether to route leaf calls to a cheaper
   `leafModel`.

If a requested source already exists as a bundled tool in
`@steel-dev/atlas/tools`, import it instead of writing one.

## Step 3 — Generate the researcher module

Write a single module (e.g. `researchers/<name>.ts`). Shape:

```ts
import { Atlas, researchTool } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const domainTool = researchTool({
  description: "<what it searches; that each result becomes a citable source>",
  inputSchema: z.object({ query: z.string(), limit: z.number().default(5) }),
  execute: async ({ query, limit }, ctx) => {
    const hits = await callTheSource(query, { limit, signal: ctx.signal });
    for (const h of hits)
      ctx.addSource({ url: h.url, title: h.title, content: h.text });
    return hits.map((h) => `- ${h.title} — ${h.url}`).join("\n");
  },
});

export const myResearcher = new Atlas({
  model: anthropic("claude-sonnet-4-6"),
  instructions: "<domain framing from Step 2>",
  tools: { domainTool },
});
```

Rules:

- Tools **only add sources**. Never have a tool summarize, score, or decide
  verification — that belongs to the engine.
- Read auth from `process.env`; surface a clear error if the var is missing.
- `tools` is a record: use a descriptive key (it's the model-facing tool name).
  The same tool under two keys = two configurations.
- Keep it small. Don't add validators, fixtures, or schema files — contract types
  are imported from the package, not copied.

## Step 4 — Smoke-test

Typecheck first:

```bash
npx tsc --noEmit <module path> 2>&1 | tail -20
```

Then, only if the user confirms (a live run spends model + Steel credits and the
source's API quota), run one narrow query and check it produces verified claims:

```ts
const r = await myResearcher.research("<small in-domain question>");
console.log(r.stats, r.claims.confirmed.length, r.citedSources.length);
```

Guard the run on the required env vars being set; if they're missing, stop and
tell the user which to export (never accept keys in chat).

## Step 5 — Hand off

Show the user the module path, how to run it (`myResearcher.research(...)` or
`.stream(...)`), and which env vars it needs. If you wrote a tool for a source
that looks broadly useful (a public API like arXiv, PubMed, Semantic Scholar),
mention it could be contributed back as a bundled tool.

## Boundaries

- Generate code in the **user's** repo (their `researchers/` / `tools/`). Never
  edit files inside `@steel-dev/atlas` or `node_modules`.
- Never reimplement or bypass scoping, claim extraction, verification, or
  synthesis. Tools add sources; the engine does the rest.
- Never copy or fork the data contract — import types from the package.
- Never put API keys in code or chat; use `process.env`.
