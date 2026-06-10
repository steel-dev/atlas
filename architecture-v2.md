# Atlas — Architecture v2

**Target architecture + migration plan**

| | |
|---|---|
| Status | Proposal |
| Date | 2026-06-10 |
| Applies to | `~/nenlabs/atlas` (current prototype, ~16k LOC in `src/`) |
| Companion | `atlas-spec.md` (greenfield product spec — the *what*; this doc is the *how to get there from here*) |

---

## 0. Thesis

The whole engine reduces to **one recursive primitive, one shared budget, one shared ledger, and one final binding pass.** A `runAgent` primitive that holds a `spawn` tool is simultaneously the lead, the recall worker, and the verifier. Topology (single-agent vs. orchestrator-with-workers) is never configured — it *emerges* from the lead's spawn decisions under a tree-shared budget. Subagents isolate their *reasoning context* but share one *claim ledger* (the blackboard). A final citation-binding pass turns verified claims into a cited report.

This deletes the scaffolding that exists only to work around two root constraints, and replaces ~5,000 lines and four product surfaces with one primitive.

```ts
const atlas = new Atlas({ model: anthropic("claude-fable-5") });
const result = await atlas.research("What's changing in browser automation for AI agents?");
```

## 1. Why v2 — the two root causes

Most of the deletable code in the current prototype exists to work around two constraints. v2 removes the constraints, not just the symptoms.

- **Root cause 1 — one shared, ever-growing lead context.** Spawned: the re-anchor machinery (`research-loop.ts`), and the `recall`/`survey` split (two near-identical pipelines in `recall.ts`). → **Context isolation removes it.** Each subagent has a private bounded context; the lead reads a ledger digest, not a growing transcript.
- **Root cause 2 — a fixed-size verification panel rationed against a budget.** Spawned: the batching/floor/cap loop, the verify on/off switch, the 20% budget reserve, the candidate backdoor. → **Emergent budget-scaled spawning removes it.** Verification is just more spawns, scaled by the same shared budget.

## 2. Design principles

1. **One primitive.** Lead, researcher, verifier are all `runAgent` with different specs. No bespoke loops.
2. **Topology is emergent, bounded.** The lead decides whether/how much to spawn; the budget envelope and depth/breadth caps bound it. We never select a topology.
3. **Budget is the selector and the only test-time-compute knob.** Tree-shared, denominated in $. Cheap budget ⇒ inline ⇒ single-agent. Rich budget + broad query ⇒ fan-out.
4. **Isolate reasoning, share the artifact.** Subagents keep private context; they write structured claims to one ledger and return only a short note. The lead never sees raw transcripts or raw page text.
5. **The trace is the product.** The ledger + event stream + journal are the durable, inspectable, resumable record. UIs render from it.
6. **Cut to the path from question → cited report.** Anything not on that path (model-driven CDP browsing, SERP scraping, a webapp, a tool zoo) leaves core.
7. **Build on AI SDK 6 (`LanguageModelV3`).** Do not reimplement the agent loop, tool calling, retries, or message types.

## 3. Target module layout

```
src/
  atlas.ts            # public class; binds config, starts runs
  run.ts              # run handle: events stream + result promise + journal
  agent.ts            # runAgent — THE primitive (replaces agent-loop + research-loop + recall + castVote)
  orchestrator.ts     # the lead's spec: plan → spawn/act → integrate → finish
  budget.ts           # tree-shared BudgetMeter; effort → envelope
  ledger.ts           # the blackboard: claims, sources, verdicts, cross-subagent merge (was claims.ts)
  verify.ts           # verify-subagent spec + lens prompts + settle rule (no panel/batching)
  synthesize.ts       # one synthesis path
  bind.ts             # citation binding — the final pass (NEW)
  structured.ts       # structured output (optional second pass)
  providers/
    search.ts         # SearchProvider interface + tavily/exa/brave/native adapters
    fetch.ts          # FetchProvider chain: basicFetch → steel() escalation
    store.ts          # RunStore: memory/file journal
  tools.ts            # tool registry: spawn, search, fetch, read_source, search_sources, run_code
  model.ts            # THIN AI SDK 6 wrapper (budget/abort/concurrency only)
examples/             # cli, serve webapp, eval explorer  (moved out of core)
evals/                # browsecomp, draco, the eval harness (kept)
```

## 4. The core primitive

Everything is this one function with a different spec:

```ts
async function runAgent(ctx: RunCtx, spec: AgentSpec): Promise<AgentResult>

interface AgentSpec {
  role: "orchestrator" | "research" | "verify";
  task: string;          // self-contained objective — the load-bearing contract
  tools: ToolName[];     // which tools this agent may call
  budget: BudgetGrant;   // a slice drawn from the shared pool
  depth: number;         // recursion depth (capped)
}

interface AgentResult {
  note: string;          // condensed "found / still-open" — NOT the transcript
  claimsAdded: string[]; // ledger ids written by this agent and its descendants
  spent: Spend;          // tokens/$ consumed; returned to the parent for accounting
}
```

`spawn` is just a tool whose handler calls `runAgent` recursively and returns the child's `note` + `claimsAdded` — never its context:

```ts
spawn({ role, task, tools?, budgetFraction? }) => { note, claimsAdded }
```

The loop body (one implementation, governed by budget + abort, on top of AI SDK 6):

```
loop:
  if budget.floored() or signal.aborted: break
  step = await model.generate({ system(role), tools, messages })   # AI SDK does the tool loop primitive
  if step has no tool calls: break                                 # implicit finish
  results = await runTools(step.toolCalls)                          # spawn is just one of these
  messages.push(step, results)
return { note: lastText, claimsAdded, spent }
```

There is no separate `finish` tool (no tool call = done) and no `plan` tool (the plan is the first turn's text, logged as an event).

## 5. Budget = the topology selector

One `BudgetMeter` for the whole run, tree-shared, denominated in USD (or lead-equivalent tokens, reusing the current cost-weighting in `pricing.ts`).

```ts
interface BudgetMeter {
  total: number;            // USD ceiling (hard)
  spent(): number;
  remaining(): number;
  grant(fraction|abs): BudgetGrant;   // a child sub-meter that draws from the pool
  floored(): boolean;       // remaining < spawn floor
}
```

- The meter is **exposed to the lead** in every anchor and tool result: *"≈ $3.80 of $5.00 left."* Spawn decisions become economically grounded.
- `spawn` draws a grant from the shared pool; when `floored()`, `spawn` refuses ("insufficient budget — do it inline or finish"). This is the runaway guard *and* the topology selector.

`effort` sets the envelope; it does **not** select a topology:

| effort | budget | depth cap | breadth cap (spawns/turn) |
|---|---|---|---|
| fast | ~$0.50 | 1 | 1 |
| balanced | ~$2.50 | 2 | 4 |
| deep | ~$10 | 3 | 8 |
| max | ~$40 | 4 | 12 |

The orchestrator prompt carries explicit scaling heuristics (models miscalibrate without them — Anthropic's documented lesson): *fact → answer inline; comparison → 2–4 workers; broad survey → fan out wide.*

## 6. The orchestrator loop

The lead is `runAgent` with `role: "orchestrator"` and the toolset `{ spawn, search, fetch, read_source, search_sources, run_code }`. Its turns:

1. **Plan** — first turn states the approach ("answer inline" / "spawn k workers on these sub-questions"). Emitted as a `plan` event — this *is* the emergent topology, made inspectable and resumable.
2. **Act** — either call research tools directly (single-agent path) or `spawn` research-subagents (orchestrator path). Children isolate context, write claims to the ledger, return notes.
3. **Integrate** — read the ledger *digest*; gaps remain → spawn more (possibly deeper); central/contested claims → spawn verify-subagents; budget left → continue.
4. **Finish** — saturated or budget-floored → stop calling tools. Synthesis + binding run as the final stage.

No re-anchoring: the lead's context is `plan + child notes + ledger digest`, bounded by construction.

## 7. The blackboard ledger

Keep today's `claims.ts` design (rename to `ledger.ts`) — verbatim-quote claims with source, quality, provenance, status, votes. Subagents write concurrently (the async queue/settle already exists); they return only a note. The lead reads `renderLedgerDigest`, never raw claims-in-bulk or page text.

**The one genuinely new cost — cross-subagent merge/dedup.** N blind parallel workers will surface overlapping claims and sources. Strategy, cheapest-first:

1. **Source dedup** by normalized URL — already have `normalizeUrlForSource` and the round-robin `dedupeCandidates`. Keep.
2. **Claim dedup** by a cheap key: `(normalizedClaimText, sourceId)`. Exact/near-exact dupes drop on write.
3. **Semantic merge** — periodic, lead-driven: when the digest shows near-duplicate claims, the lead (or a cheap merge call) combines them and unions their sources. Defer embedding-based clustering to v1+; do not build it first.

> **Validate this before committing the refactor.** This is where saved complexity partially returns. Prototype the blackboard merge on a 5-worker fan-out and confirm dedup quality before deleting the single-pass recall path.

## 8. Verification = emergent spawn

No fixed panel, no batching/floor/cap, no on/off switch. A verify-subagent is `runAgent` with `role: "verify"`, a lens prompt, a verdict schema, and `{ search, read_source, run_code }`. The lead spawns them for central/contested claims, scaled by budget; verdicts are written to the ledger.

Tiers fall out of budget, not config:

| budget | verification that emerges |
|---|---|
| tiny | mechanical quote-check only (free, always-on — `quoteSupportedIn`) |
| moderate | + spawn 1 verifier on central claims |
| rich | + adversarial multi-lens spawns on central + contested claims |

What survives from today's `verify.ts`: the **lens prompts** (quote-fidelity / contradiction / source-strength — they're good) and the **`settleClaim` rule** (quorum of non-refuting votes ⇒ confirmed; too few ⇒ unverified). What dies: `confirmQuotedClaims` (the no-op default), `verifyClaims` batching, the panel sizing, the `verify` mode switch, `resolveVerify`, `ATLAS_VERIFY`.

## 9. Citation binding — the signature pass

Net-new (`bind.ts`); today's `reconcileCitations` only checks URL presence. Over the drafted report:

1. Split into sentences; collect claim-id markers the synthesizer emitted inline.
2. For each factual sentence: confirm its claim's quote still exists in the stored source (`quoteSupportedIn`), then confirm the sentence is **entailed** by claim + quote (cheap model). Broken → rewrite / re-ground / flag.
3. Factual sentences with no marker → flagged (`citationsUnsupported`); rich budget attempts re-grounding.
4. Emit `citations[]` with character spans so products render hovercards without parsing markdown.

Release gate: ≥95% of cited sentences pass the support check on the golden set; <2% unsupported factual sentences in deep mode.

## 10. Providers

- **Search defaults to an API** (`tavily()` / `exa()` / `brave()` / `nativeModelSearch()`), not browser SERP scraping. `nativeModelSearch()` (Anthropic/OpenAI/Gemini server-side search) is the zero-extra-key default when the model supports it. SERP scraping survives only as an optional contrib provider.
- **Fetch is a chain**: `basicFetch()` (undici + readability + PDF) is the free default; `steel()` is the escalation for JS-rendered / anti-bot / paywalled / captcha pages — triggered on block markers or empty extraction. **Steel is the upgrade, not the gate** (no hard `STEEL_API_KEY` requirement to start).
- **`RunStore`** journals every model/search/fetch call for resume (`memoryStore()`, `fileStore(dir)`).

## 11. Safety

Context isolation **shrinks** the injection surface — the lead consumes distilled claims, not raw page text, so a poisoned page has fewer places to steer the orchestrator. It does **not** eliminate it. Still required (from `atlas-spec.md` §9, grounded in the system cards' ~30% raw-model hijack rate under adaptive attack):

- **Quarantine** fetched content in provenance-tagged delimiters; instruct models that delimited content is data, not instructions.
- **No privileged/state-changing tools downstream of fetched content.** Read-only by construction.
- **SSRF + URL-exfiltration guard** on every fetch (scheme allowlist, private-IP block post-DNS, query-entropy heuristic on new domains).
- **`run_code` must not be an in-process Node `vm`** over untrusted text — move to an out-of-process / WASM sandbox, or restrict it to operating on structured ledger data only.

## 12. Public API (delta from spec)

Unchanged from `atlas-spec.md` §4 — `research()` one-shot, `start()` → events + `result()`, structured output, `Atlas.resume(id)`. The v2-specific surface:

- `effort` sets the budget envelope; `budget.maxUSD` is a hard ceiling.
- Events gain `plan.updated` (the declared topology), `agent.spawned`, `agent.returned`.
- `result.stats` reports the emergent shape: `{ agentsSpawned, maxDepth, singleAgent: boolean, ... }`.

## 13. Honest divergence from the Mythos/Fable 5 card

This is **informed by** the card's findings (async > blocking: 93.3 vs 89.9; token spend explains ~80% of variance) but is **not** a reproduction of its architecture. The card describes three *fixed, separately-evaluated* harnesses with *per-agent* budgets and *message/return* coordination, where topology is the experimenter's variable. v2 deliberately diverges on three load-bearing points, because a product library has different constraints than a capability eval:

- **Emergent topology** (card fixes it) — for a library that must scale from a 10¢ query to a $20 survey.
- **Tree-shared budget** (card uses per-agent ceilings) — because a library needs a user `maxUSD` cap.
- **Claim blackboard** (card uses messages/returns; only the lead's output graded) — because a library needs a durable, inspectable, citable claim graph.

Caveat to hold honestly: the card's *best* result came from a *fixed* async harness. There is no evidence emergent selection matches it on peak BrowseComp. We are optimizing for **adaptivity + cost-bounding + simplicity**, not peak capability under a fixed harness.

## 14. The cut list

Order-of-magnitude: Tiers 1+2 remove **~5,000+ lines** of ~16k `src`, and take the repo from *four products* to *one primitive*. Each cut names what you lose.

### Tier 1 — free cuts (pure weight, ~no loss)

| Cut | Files / ~lines | Loss |
|---|---|---|
| `model.ts` re-abstraction → thin AI SDK 6 wrapper | `model.ts` ~572 | none (reimplements the SDK) |
| Webapp + eval explorer → `examples/` | `serve.ts` 374 + `serve.page.html` + `evals/explore/*` ~3,000 | none to the library |
| Bundled domain tools → `@steel-dev/atlas-tools` | `src/tools/*` (arxiv/pubmed/SEC/ClinicalTrials/Semantic Scholar/…) | none (they're seam demos) |
| Env-var tuning channel | plumbing in `config-resolution.ts` | none (collapse into `budget`+`effort`) |
| Double vocabulary `depth` + `effort` → one | `config-resolution.ts` | none |
| Report-builder triplication → one synthesis path | `synthesize.ts` `fallbackReportFromClaims`/`inconclusiveReport` + `selectCandidates` in `research.ts` | a little defensive padding |
| Implicit `finish`/`plan` (no dedicated tools) | `tool-registry.ts` | none |

### Tier 2 — high-value cuts with a named tradeoff (do, eyes open)

| Cut | Files / ~lines | Tradeoff |
|---|---|---|
| **SERP scraping → search API default** | `search.ts` 407 + parts of `search-provider.ts` 412 / `search-tool.ts` 364 (net ~600–800) | search-API key becomes the default (industry norm); bonus: fixes "Steel required to run" |
| **Model-facing CDP → render-only fetch** | `browser-tool.ts` 205 + `browser-cdp.ts` 211 + `browser-extract.ts` 256 + `browser-session-pool.ts` 455→~150 (net ~700–900) | lose model-driven interactive browsing (defer to opt-in `deepFetch`); shrinks injection/SSRF surface |
| **Recording subsystem → rely on journal** | `recording.ts` 161 + `withRole(...)` at every call site | lose byte-exact eval replay (journal covers most) |
| **Triage stage → subagent judgment** | triage block in `recall.ts` | slightly looser fetch selection vs an explicit scoring call |
| **Structured attribution pass → coarse provenance** | second pass in `structured.ts` 275 | lose per-field citations (only cut if unused) |

### Tier 3 — tempting, but keep

| Keep | Why |
|---|---|
| `leafModel` + cost-weighting (`pricing.ts`) | model-tiering is high-leverage on cost; earns its math |
| Adaptive concurrency gate | borderline; collapsing to one semaphore + SDK retry is fine — minor either way |
| `fetch-tool.ts` (878) / `html-extract.ts` (485) | extraction quality is upstream of every claim — **audit for gold-plating, don't gut** |

## 15. Migration map (checklist)

| File | Fate |
|---|---|
| `agent-loop.ts` | → `agent.ts` `runAgent`, generalized. **Keep + extend.** |
| `research-loop.ts` | → `orchestrator.ts` spec. Re-anchor machinery **deleted**. |
| `recall.ts` | `runRecall`/`runSurvey` **deleted**; triage optional/removed; research-subagent spec replaces it. |
| `verify.ts` | → verify-subagent spec + lens prompts + `settleClaim`. Panel/batching/`confirmQuotedClaims`/mode-switch **deleted**. |
| `claims.ts` | → `ledger.ts` (the blackboard). **Keep.** Add cross-subagent merge. |
| `synthesize.ts` | one synthesis path. **Keep, simplify.** |
| `structured.ts` | **Keep** (optionally drop attribution pass). |
| `runtime.ts` | budget meter → tree-shared `budget.ts`; `researchBudgetExhaustedReason` + 0.2 reserve **deleted**; gates kept. |
| `config-resolution.ts` | `effort → {budget, depth, breadth}` map; verify-mode + reserve + env plumbing **deleted**. |
| `tool-registry.ts` | → `tools.ts`; add `spawn`; action-budget classification **deleted** (one currency). |
| `model.ts` | thin AI SDK 6 wrapper; converters/retry/cache-leak **deleted**. |
| `research.ts` | shrinks to run wiring; `reconcileCitations` → `bind.ts` real binding. |
| `search.ts` | SERP scrapers **deleted**; `providers/search.ts` adapters replace. |
| `browser-*.ts` | CDP tool surface **deleted**; `providers/fetch.ts` `steel()` render-only escalation. |
| `recording.ts` | **deleted**; journal serves debugging. |
| `cli.ts`, `serve.ts`, `evals/explore/*` | → `examples/`. |

## 16. The floor — do not cut past here

The irreducible core, the thing that *is* Atlas:

1. the **`spawn` primitive** (one recursive agent),
2. the **claim ledger** (the blackboard),
3. **mechanical quote-checking** (free, gates every claim),
4. the **budget meter** (the one knob),
5. **citation binding** (the differentiator).

Everything in Tiers 1–2 is removable because it is either reimplemented infrastructure or a capability surface that wandered into a library. Cut all of it and you still have a model-agnostic question → cited-report engine — the whole pitch.

## 17. Two traces (same code path)

- **"Capital of Australia?"** → orchestrator plans *inline*; one `search` + `fetch`; one quote-checked claim; budget too small to spawn; synthesis = one cited sentence. **Single-agent emerged.**
- **"Compare the top 5 deep-research frameworks on license, language, benchmarks."** → plans *spawn 5 workers* (one per framework); each isolates context, writes ~6 claims; lead sees license claims thin on two → spawns 2 follow-ups; spawns verify-subagents on the contested benchmark numbers; synthesis → table; binding verifies each cell. **Orchestrator emerged.**

Same `runAgent`. The only difference is spawn decisions under budget.

## 18. Risks & what to validate

1. **Cross-subagent merge quality** (§7) — the place saved complexity returns. Prototype first; gate the recall deletion on it.
2. **Emergent vs. fixed topology on score** — emergence buys adaptivity, not proven peak capability. Validate on BrowseComp-Plus that the emergent path stays within a few points of a fixed async harness; if it doesn't, pin a fixed shape at high effort.
3. **Subagent task-spec quality** — emergent spawning means the model authors specs on the fly (Anthropic's #1 failure mode). The declared-plan step + crisp spawn-prompt templates are the mitigation; watch for duplicated/divergent worker effort in traces.
4. **Citation binding cost** — the entailment pass scales with report length; keep it on the cheap role and cap sentences re-grounded per budget tier.

---

### Appendix — companion documents

- `atlas-spec.md` — greenfield product spec (full public API, eval harness, packaging, milestones).
- Anthropic, *How we built our multi-agent research system* (2025-06) — orchestrator-worker, citation pass, effort-scaling prompts.
- Fable 5 / Mythos 5 System Card §8.15 — the three fixed harnesses + the findings v2 is informed by.
