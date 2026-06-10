# Atlas — Open-Source Deep Research Agent

**Technical Specification**

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-06-10 |
| Working name | `@steel-dev/atlas` (see §1.1 — rename recommended before public README) |
| License | Apache-2.0 |
| Language | TypeScript (Node ≥ 20, Bun) |
| Foundation | Vercel AI SDK 6 (`LanguageModelV3` spec) |

---

## 0. One-paragraph summary

Atlas is a model-agnostic, embeddable TypeScript library that turns a question into a verified, cited research report. It is a **primitive, not a framework**: one job (`research()`), done with production-grade machinery that no OSS alternative ships — an auditable claim ledger, adversarial verification, report-level citation binding, budget control, resumable runs, and a benchmark harness in the repo. The simple path is two lines; the product path exposes streaming events, structured output, durability, and the full trace. Search is pluggable and commoditized; fetching hostile pages (JS-rendered, anti-bot, paywalled, PDFs) routes to Steel sessions — the OSS → infra conversion hook, mirroring the Stagehand → Browserbase playbook.

```ts
import { Atlas } from "@steel-dev/atlas";
import { anthropic } from "@ai-sdk/anthropic";

const atlas = new Atlas({ model: anthropic("claude-fable-5") });
const result = await atlas.research("What's changing in browser automation for AI agents?");
```

### 0.1 Why this exists (evidence, 2026-06)

- **The slot is empty.** No model-agnostic, embeddable, maintained TS research library exists. Research-specific npm packages are statistically dead (`deep-research` 27 DL/wk, `node-deepresearch` 2 DL/wk); the high-star TS projects are unmaintained apps or unpublished scripts (dzhng 19.1k★, never on npm; nickscamara dead 2025-05). Python has gpt-researcher (embeddable, ~25k DL/wk) but no TS bridge. `deepagents` (1.2M PyPI DL/wk) proves developers buy harnesses and are left to assemble research quality themselves.
- **Harnesses remain competitive.** RL-trained end-to-end research models did not obsolete orchestration; the 2026 leaders are all trained-model + test-time orchestration, and orchestration adds ~3–10 points on top of any model (Kimi K2.6 swarm +3.1 BrowseComp; Tongyi Heavy +5.4 HLE; Anthropic multi-agent +90.2% over single-agent internally; Fable 5 system card: 88.0 → 93.3 BrowseComp single → multi-agent).
- **Citation integrity is the open flank.** Industry citation accuracy is 40–80% (DeepTRACE, arXiv:2509.04499); >60% of AI-search citations were wrong in CJR's audit; citation quality is Claude's weakest DRACO criterion (Opus 4.8 card p.207). Nobody credible ships sentence-level verified citations. Atlas's signature feature.
- **Hosted research endpoints commoditize; libraries don't.** Firecrawl deprecated `/deep-research` (2025-06); Gemini sells deep research at plain token rates; o4-mini-deep-research is $2/$8 per MTok. What a vendor endpoint cannot offer: pipeline ownership, BYO models/search, private data, custom report contracts, embeddability.

## 1. Goals and non-goals

### Goals

1. **G1 — Embeddable primitive.** Products call `research()` and get back a report + structured findings + full trace. Stable, semver'd API.
2. **G2 — Model-agnostic.** Any `LanguageModelV3` works. Quality scales with the model; no Anthropic lock-in (but "best on Claude" presets are fine).
3. **G3 — Verifiable output.** Every load-bearing sentence in the report is bound to a claim, a verbatim quote, and a source URL, and the binding is machine-checked before the run completes.
4. **G4 — Honest economics.** First-class budget caps (USD/tokens/time), effort tiers with published cost curves, graceful degradation on exhaustion.
5. **G5 — Production shape.** Streaming events, resumable journaled runs, durability adapters, structured output against user schemas, OTel.
6. **G6 — Benchmarked.** Eval harness in-repo, scores + $/run published per release, regressions gate releases.
7. **G7 — Steel-native upgrade path.** Plain fetch by default; one line to route fetching through Steel sessions for the hostile web.

### Non-goals

- **N1** — Not a general agent framework (Mastra/deepagents/OpenAI Agents own that layer).
- **N2** — Not a hosted API (Steel may run one later; library-first).
- **N3** — Not a crawler/scraping toolkit, not a RAG library (no embedding store; integrates with them as sources, v1+).
- **N4** — Not browser *automation* (that is Stagehand-shaped; Atlas uses browsers only as a fetch/browse substrate).
- **N5** — No state-changing actions on external sites. Read-only by construction (§9).
- **N6** — No UI in core (examples ship a Next.js app and CLI).

### 1.1 Naming requirement

"Atlas" collides with ChatGPT Atlas (OpenAI's browser — same conceptual space), MongoDB Atlas (owns dev SEO), atlasgo, Nomic Atlas; bare npm `atlas` is squatted since 2017. **Requirement:** choose an ownable single word with no AI/dev-tool collision before anything public. This spec uses Atlas as a working title only. Selection criteria: ≤3 syllables, available bare on npm, no top-20 dev-tool collision, evokes inquiry/maps/depth without being generic.

## 2. Users and use cases

| User | Use case | What they need from Atlas |
|---|---|---|
| Product engineer | "Research" feature inside a SaaS app | `start()` + events for UI, structured output, budget caps, resume after deploy |
| Agent builder | Research as a tool inside a larger agent | one-shot `research()` with `effort: "fast"`, low latency, trace for grounding |
| Data/ops team | Scheduled market/competitor briefs | CLI/cron, durable runs, report formats, source filters |
| Researcher/hacker | Best-effort answer machine | two-line path, local models, cheap mode |

## 3. Design principles

1. **Progressive disclosure.** `await atlas.research(q)` must always work in one line. Every advanced capability is opt-in and additive.
2. **The trace is the product.** Builders render UIs from the ledger, not from prose. Trace schema is versioned and stable.
3. **Policy ≠ engine.** Fan-out counts, vote thresholds, and round limits are *policy* (tunable, eval-driven, query-adaptive within caps). The engine (agent runtime, journal, ledger, binding) is invariant.
4. **Budget is the quality knob — say so.** Token spend explains ~80% of variance on agentic search (Anthropic, 2025-06). Effort tiers map to budgets and publish expected cost.
5. **Untrusted web, trusted ledger.** Fetched content is data, never instructions. Trust is earned per-claim through verification, not assumed per-source.
6. **No silent caps.** Anything dropped (dupes, budget, refusals, fetch failures) is counted and reported in `stats`.

## 4. Public API

### 4.1 Constructor

```ts
import { Atlas } from "@steel-dev/atlas";

const atlas = new Atlas(config: AtlasConfig);

interface AtlasConfig {
  model: LanguageModel;
  models?: Partial<Record<Role, LanguageModel>>;
  search?: SearchProvider | SearchProvider[];
  fetch?: FetchProvider | FetchProvider[];
  effort?: Effort;
  budget?: Budget;
  trust?: TrustPolicy;
  store?: RunStore;
  pricing?: PricingTable;
  telemetry?: TelemetryOptions;
  safety?: SafetyPolicy;
}

type Role = "lead" | "search" | "extract" | "verify" | "write";
type Effort = "fast" | "balanced" | "deep" | "max";
```

Defaults: `models` falls back to `model` for every role. `search` defaults to the model provider's native search tool when available (Anthropic `web_search`/`web_fetch`, OpenAI Responses `web_search`, Gemini Search), else throws with a clear message listing adapters. `fetch` defaults to `basicFetch()`. `effort` defaults to `"balanced"`. `store` defaults to in-memory (resume works within process; persistent stores opt-in).

Rationale for role split: effort-scaling curves are steep on search tasks and calibration differs by role — abstention-calibrated models suit `verify`, aggressive models suit `lead`/`write`, cheap models suit `extract` (Fable 5 card pp.140–146, 267–271).

### 4.2 One-shot and handle APIs

```ts
const result = await atlas.research(question: string, options?: ResearchOptions);

const run = atlas.start(question: string, options?: ResearchOptions);

interface ResearchOptions {
  effort?: Effort;
  budget?: Budget;
  output?: OutputSpec;
  clarify?: ClarifyHandler | false;
  sources?: SourceFilter;
  locale?: string;
  signal?: AbortSignal;
  now?: Date;
  runId?: string;
}

type OutputSpec =
  | { kind: "report"; format?: "markdown"; audience?: string; length?: "brief" | "standard" | "long" }
  | { kind: "structured"; schema: ZodType };

type ClarifyHandler = (questions: ClarifyingQuestion[]) => Promise<ClarifyingAnswer[]>;

interface SourceFilter {
  includeDomains?: string[];
  excludeDomains?: string[];
  freshness?: { after?: Date };
  languages?: string[];
}

interface Budget {
  maxUSD?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxSources?: number;
}
```

`research()` is sugar: `start()` + drain events + `result()`.

`clarify`: if the lead agent judges the question underspecified, it emits `clarification.needed` and invokes the handler. Default when omitted: do **not** block; proceed with stated assumptions, recorded in `result.assumptions`. Products that want blocking clarification pass a handler.

### 4.3 Run handle

```ts
interface ResearchRun {
  id: string;
  events(): AsyncIterable<ResearchEvent>;
  result(): Promise<ResearchResult>;
  pause(): Promise<void>;
  cancel(): Promise<void>;
  status(): RunStatus;
}

Atlas.resume(id: string, config: AtlasConfig): ResearchRun;
```

`pause()` finishes in-flight provider calls, journals state, and parks the run. `Atlas.resume(id)` reconstructs from the journal; completed agent calls with unchanged call-keys replay from cache (§7.3).

### 4.4 Events

Discriminated union, JSON-serializable, schema-versioned (`eventVersion`). Minimum set:

```ts
type ResearchEvent =
  | { type: "run.started"; question: string; effort: Effort; budget: Budget }
  | { type: "clarification.needed"; questions: ClarifyingQuestion[] }
  | { type: "plan.updated"; facets: Facet[]; rationale: string }
  | { type: "round.started"; round: number; objectives: string[] }
  | { type: "search.completed"; query: string; provider: string; results: number }
  | { type: "source.fetched"; sourceId: string; url: string; quality: SourceQuality; via: string }
  | { type: "source.failed"; url: string; reason: string }
  | { type: "claim.extracted"; claim: ClaimRef }
  | { type: "claim.verified"; claimId: string; status: ClaimStatus; votes?: VoteSummary }
  | { type: "round.completed"; round: number; novelClaims: number; saturation: number }
  | { type: "finding.partial"; finding: Finding }
  | { type: "report.drafting"; section: string }
  | { type: "citation.bound"; sentenceId: string; claimId: string; ok: boolean }
  | { type: "budget.warning"; spentUSD: number; limitUSD: number; fraction: number }
  | { type: "safety.flag"; kind: SafetyFlagKind; detail: string; sourceId?: string }
  | { type: "provider.fallback"; role: Role; from: string; to: string; reason: string }
  | { type: "run.completed"; stats: RunStats }
  | { type: "run.error"; error: SerializedError; recoverable: boolean };
```

Requirement: a UI consuming only events can render full progress (the dominant integration mode; deep runs take minutes and products must show interim findings to make latency tolerable).

### 4.5 Result

```ts
interface ResearchResult {
  runId: string;
  question: string;
  assumptions: string[];
  report: string;
  structured?: unknown;
  findings: Finding[];
  contested: ContestedClaim[];
  openQuestions: string[];
  sources: SourceRecord[];
  citations: Citation[];
  stats: RunStats;
  traceVersion: string;
}

interface Finding {
  id: string;
  statement: string;
  confidence: "high" | "medium" | "low";
  claimIds: string[];
  sourceIds: string[];
}

interface Citation {
  sentenceSpan: [number, number];
  claimId: string;
  sourceId: string;
  quote: string;
  verified: boolean;
}

interface RunStats {
  effort: Effort;
  rounds: number;
  searches: number;
  sourcesFetched: number;
  sourcesFailed: number;
  claimsExtracted: number;
  claimsVerified: number;
  claimsContested: number;
  claimsRefuted: number;
  citationsBound: number;
  citationsUnsupported: number;
  dupesDropped: number;
  budgetDropped: number;
  tokens: Record<Role, { input: number; output: number }>;
  costUSD: number;
  durationMs: number;
  budgetExhausted: boolean;
  fallbacks: number;
}
```

`report` is markdown with footnote-style citation markers; `citations[]` binds character spans to ledger entries so products can render hover-cards/highlights without parsing markdown.

### 4.6 Errors

Typed error hierarchy: `AtlasError` → `ConfigError`, `ProviderError` (carries provider + retryable flag), `RefusalError` (carries structured refusal category; see §9.6), `BudgetExceededError` (only thrown if budget exhausted before *any* synthesizable output exists; otherwise degrade per §6.6), `ResumeError`. All errors serialize into the journal.

## 5. Architecture

### 5.1 Layering

```
┌─────────────────────────────────────────────────┐
│ Public API  (Atlas, ResearchRun, events, types) │
├─────────────────────────────────────────────────┤
│ Research loop (policy)                          │
│  scope → rounds(search/fetch/extract) →         │
│  verify tiers → synthesize → bind citations     │
├─────────────────────────────────────────────────┤
│ Ledger (claims, sources, verdicts, provenance)  │
├─────────────────────────────────────────────────┤
│ Engine (invariant substrate)                    │
│  agent calls w/ forced schema · async fan-out   │
│  w/ caps · journal/replay · cost meter · safety │
│  interceptors                                   │
├─────────────────────────────────────────────────┤
│ Providers: LanguageModel (AI SDK 6) · Search ·  │
│  Fetch · RunStore                               │
└─────────────────────────────────────────────────┘
```

The engine is the durable engineering investment (the part Claude Code's Workflow tool implements internally and does not export). The loop is replaceable policy and must be tuned by evals, never hand-feel.

### 5.2 Engine substrate

```ts
interface AgentCall<T> {
  role: Role;
  label: string;
  prompt: string;
  tools?: ToolSet;
  schema?: ZodType<T>;
  maxSteps?: number;
  effortHint?: "low" | "medium" | "high";
}
```

Requirements:

- **E1 — Forced structured output.** When `schema` is set, the final answer is a tool call validated against the schema, with bounded re-ask on validation failure (max 2 retries). Built on AI SDK 6 `ToolLoopAgent`/`generateText` primitives.
- **E2 — Concurrency.** Per-run cap (default `min(8, providerLimit)`), fair-queued; fan-out helpers `all()` (barrier) and `stream()` (no barrier — results consumed as they land). Default to no-barrier composition.
- **E3 — Journal.** Every provider call (model/search/fetch) is journaled with `callKey = hash(role, prompt, toolsetId, schemaId, providerId)` and its response. Replay on resume: unchanged prefix served from journal; first divergence runs live. Journal is JSONL; entries are events (§4.4) plus call records.
- **E4 — Cost meter.** Token usage per role from provider metadata; USD via `pricing` table (shipped defaults for major providers, user-overridable, versioned — prices change monthly and must not be hardcoded in logic).
- **E5 — Abort/pause propagation** to all in-flight calls via `AbortSignal`.
- **E6 — Safety interceptors** wrap every fetch/search/model call (§9).
- **E7 — Determinism hooks.** No direct `Date.now()`/`Math.random()` in policy code; injected clock/RNG (test + replay stability).

### 5.3 Research loop

Lead-agent iterative loop with async workers. Chosen over single-shot fan-out and over a blocking orchestrator on direct evidence: async/non-blocking multi-agent beats blocking orchestration on accuracy *and* latency *and* tokens (Fable 5 card §8.15: BrowseComp 93.3 async vs 89.9 blocking vs 88.0 single; blocking loses latency to sync barriers and tokens to context re-establishment).

```
scope(question, clarify?) → facets[], strategy, assumptions

loop rounds (until stop):
  lead reviews memo + ledger gaps
  dispatch workers (async, capped):
    searcher(facet | follow-up query)  → results
    fetcher(url)                        → content
    extractor(content)                  → claims w/ quotes → ledger
  lead integrates: dedup, gap analysis, follow-up leads,
                   primary-source chase, memo rewrite

stop when: saturation (novel-claims/round < τ for 2 rounds)
        or facet coverage declared
        or round/budget cap

verify (tiered by effort, §5.5)
synthesize (outline → sections → assemble, §5.6)
bind citations (§5.7)
```

- **L1 — Memo, not transcript.** The lead maintains a bounded working memo (current synthesis state, open gaps, leads) rewritten each round — IterResearch-style workspace reconstruction rather than monotone context append. Compaction threshold default 100k tokens (matches Anthropic's own orchestrator settings).
- **L2 — Query-adaptive effort within caps.** The lead decides rounds/fan-out inside the effort tier's ceilings; prompts encode explicit scaling heuristics (simple fact → 1 worker, 3–10 tool calls; comparison → 2–4 workers; open survey → full tier). Anthropic found models overspend or underspend without explicit rules.
- **L3 — Start broad, then narrow.** Encoded in searcher prompts; short queries first, refine on evidence.
- **L4 — Primary-source chase.** When a secondary source cites a primary (paper, filing, changelog, spec), the lead schedules a fetch of the primary; claims upgraded when re-grounded in primary sources.
- **L5 — Worker prompts are self-contained**: objective, output schema, tool guidance, boundaries, and the original question verbatim. Workers return data, not prose-for-humans.

### 5.4 Ledger

The central data structure; append-only with status transitions; serialized into the trace.

```ts
interface SourceRecord {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  publishedAt?: string;
  fetchedAt: string;
  via: "search" | "follow-up" | "primary-chase" | "user";
  fetcher: string;
  quality: SourceQuality;
  trustTier: TrustTier;
  contentHash: string;
  excerptRefs: ExcerptRef[];
}

type SourceQuality = "primary" | "secondary" | "blog" | "forum" | "unreliable";

interface Claim {
  id: string;
  text: string;
  quote: string;
  sourceId: string;
  importance: "central" | "supporting" | "tangential";
  status: "unverified" | "verified" | "contested" | "refuted";
  corroboratingSourceIds: string[];
  verdicts: Verdict[];
  topics: string[];
}

interface Verdict {
  verifier: string;
  refuted: boolean;
  confidence: "high" | "medium" | "low";
  evidence: string;
  counterSourceId?: string;
}
```

Dedup: URL normalization (host minus `www`, path minus trailing slash, lowercased, tracking params stripped) for sources; embedding-free semantic key (normalized claim text) plus lead-pass merge for claims. Contested claims are **kept and surfaced** (`result.contested`), not buried — killing disputed-but-important findings biases reports toward blandness; the report must be able to say "sources disagree."

### 5.5 Verification

Tiered by effort. Design inputs: the dominant real-world failure mode of frontier models in agentic work is stating unverified claims as fact (Fable 5 card p.38: 41/886 internal sessions; fabrication under missing context pp.145–146), and verification compute must scale with stakes, not be a flat 75-agent tax (the CC workflow spent ~75% of all calls on votes regardless of difficulty).

| Tier | Applied at | Mechanism |
|---|---|---|
| V0 extraction hygiene | all efforts | claim must be falsifiable + carry verbatim quote found in source content (string-checked, not model-asserted) |
| V1 corroboration | balanced+ | central claims need ≥2 independent sources (different registrable domains) or are downgraded to `contested`; extraordinary-claim heuristic: low trust tier + strong claim → corroboration mandatory |
| V2 adversarial vote | deep+ (central+supporting), balanced (central only, 1 vote) | independent verifier agents with search access attempt refutation; quorum rules below |
| V3 counter-search | max | dedicated skeptic workers run inverted queries per major finding ("evidence against X"), distinct lenses (recency, methodology, conflict-of-interest) |
| V4 citation binding | all efforts, always | §5.7 |

Vote semantics (V2): 3 votes per claim; ≥2 refute → `refuted`; <2 valid (non-abstain) votes → remains `unverified` and is excluded from high-confidence findings (all-abstain must never pass — preserved from the CC workflow, which got this right); verifiers instructed to check quote-supports-claim, contradicting evidence, source-quality adequacy, staleness, marketing provenance; default-refute on uncertainty applies only to `central` claims.

Verifier role defaults to an abstention-calibrated model when the user provided role overrides; otherwise same model with a calibration-forward prompt.

### 5.6 Synthesis

Three stages, not one shot (RACE-style judges reward comprehensiveness, depth, instruction-following; a findings list is not a report):

1. **Outline** from facets + verified findings; honors `OutputSpec` (audience, length, or user schema).
2. **Section drafting** with only ledger-verified material in context per section; every factual sentence must reference claim IDs inline (machine markers, stripped later).
3. **Assembly**: merge, dedupe across sections, executive summary, caveats (what's uncertain, source weaknesses, staleness), open questions, contested-claims section when non-empty.

Structured output mode replaces stage 2–3 with schema-targeted generation; every leaf string field carrying a factual assertion gets claim-ID annotations in a parallel `bindings` map.

### 5.7 Citation binding (signature feature)

Final machine-checked pass over the deliverable:

1. Split report into sentences; collect claim-ID markers.
2. For each cited sentence: verify the claim's quote still exists in the stored source excerpt (string/normalized match); verify the sentence is entailed by claim + quote (verifier model, cheap role); broken → rewrite sentence, re-source, or annotate as unsupported and downgrade.
3. Sentences asserting facts with **no** marker are flagged (`citationsUnsupported`); deep/max efforts attempt re-grounding, fast/balanced annotate.
4. Output `citations[]` with character spans; strip markers; footnotes rendered.

Release-gated targets (§11): ≥95% of cited sentences pass automated support check on the golden set; <2% unsupported factual sentences in deep mode.

### 5.8 Effort tiers (initial policy; eval-tuned; all overridable)

| | fast | balanced | deep | max |
|---|---|---|---|---|
| rounds (max) | 1 | 3 | 6 | 10 |
| concurrent workers | 4 | 6 | 8 | 12 |
| sources target | ~8 | 15–25 | 30–60 | 60–150 |
| verification | V0+V4 | +V1, V2 on central (1 vote) | +V2 3-vote | +V3 |
| default budget | $0.50 | $2.50 | $10 | $40 |
| latency target p50 | <60s | <4min | <12min | <30min |

Expected cost on Sonnet-class models: fast $0.15–0.50, balanced $0.50–2, deep $2–8, max $8–30; Opus/Fable-class roughly 3–5×. Search/fetch layer adds $0.02–0.45/run (provider-dependent). Published per release with benchmark scores.

## 6. Provider interfaces

### 6.1 Search

```ts
interface SearchProvider {
  id: string;
  search(q: SearchQuery): Promise<SearchResult[]>;
  costPer1k?: number;
}

interface SearchQuery {
  query: string;
  recency?: "day" | "week" | "month" | "year" | "any";
  domainFilter?: SourceFilter;
  maxResults?: number;
  locale?: string;
}
```

Built-in adapters (plain `fetch`, zero SDK deps): `tavily()`, `exa()`, `brave()`, `serper()`, `searxng({ baseUrl })`. Special adapter `modelNativeSearch()` delegates to the provider's server-side search tool (Anthropic `web_search` $10/1k; OpenAI Responses `web_search`; Gemini grounding) — the zero-extra-keys default. Multiple providers → lead may diversify (different indexes surface different sources); results merged through dedup.

### 6.2 Fetch

```ts
interface FetchProvider {
  id: string;
  fetch(req: FetchRequest): Promise<FetchedDocument>;
  canHandle?(url: string, hint?: FetchHint): number;
}

interface FetchedDocument {
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  publishedAt?: string;
  meta: Record<string, string>;
  renderedWith: string;
}
```

Chain-of-responsibility: providers scored by `canHandle`, first success wins, failures cascade. Built-ins:

- `basicFetch()` — undici + readability extraction + PDF text extraction (pdf.js); the free default. Honors robots.txt by default (§9.5).
- `steel(options)` — Steel session fetch: JS rendering, anti-bot, captcha handling, Profiles (user-owned auth), screenshots-to-text fallback for canvas-heavy pages. Escalation triggers: basicFetch got blocked (403/429/challenge markers), empty-after-readability, content-type needs rendering. This is the OSS → infra hook; it must be genuinely optional and genuinely better.
- `jinaReader()`, `firecrawl()` — community adapters, contrib-tier.

v1+: `deepFetch()` — an interactive Steel-session browse mode (site search, docs navigation, pagination) for sources where one URL isn't enough; capability no fetch-API competitor can match. Out of v0 scope.

### 6.3 Non-web sources (v1+)

`SourceProvider` interface for user documents, vector stores, and MCP connectors (Notion/Drive/Slack). v0 ships the interface and `userDocuments([])` only; connector breadth is explicitly deferred (Onyx's moat; don't boil the ocean).

### 6.4 RunStore

```ts
interface RunStore {
  append(runId: string, entries: JournalEntry[]): Promise<void>;
  read(runId: string): AsyncIterable<JournalEntry>;
  head(runId: string): Promise<RunStatus | null>;
  list(): AsyncIterable<RunSummary>;
}
```

Built-ins: `memoryStore()`, `fileStore(dir)`. Contrib: Redis/Postgres/S3. The journal is the durability primitive; everything else (resume, replay, audit, trace export) derives from it.

## 7. Durability and deployment

- **D1** — Long-lived process is the native mode (Node service, container, Bun). Serverless guidance is documented honestly: a deep run will not fit a 60s function; use `start()` + persistent store + `resume()` across invocations, or a job runner.
- **D2** — First-party examples (not core deps): Trigger.dev task, Inngest function, Temporal activity, plain BullMQ worker. Each ≤100 lines using public API only — proving the API is sufficient.
- **D3** — Resume semantics: replay journal; identical call-keys hit cache; divergence runs live (model nondeterminism accepted; replay is prefix-caching, not bitwise determinism).
- **D4** — Graceful budget exhaustion: finish in-flight work, skip remaining verification tiers (claims stay `unverified`/`contested`), synthesize from existing ledger, set `stats.budgetExhausted`, still run V4 binding on whatever is written. A partial verified report always beats an exception after $8 of spend.

## 8. Observability

- Event stream is the primary surface (§4.4).
- Optional OTel: spans per phase/agent-call/provider-call following GenAI semconv; metrics: tokens, cost, durations, fan-out, verification outcomes.
- `result.stats` complete enough to drive dashboards without OTel.
- Trace export: `atlas.trace(runId)` → versioned JSON (ledger + events + config snapshot with secrets redacted). The trace schema is a compatibility surface (semver'd `traceVersion`).
- Telemetry to Steel: **none by default.** Opt-in anonymous usage ping only (`telemetry: { enabled: true }`); OSS trust is the asset.

## 9. Safety and robustness

Threat model: Atlas feeds untrusted web content to models in a tool loop — the canonical indirect-prompt-injection surface. Evidence baseline: under adaptive attack in browser-use environments, raw frontier models are hijacked in ~30% of attempts (Fable 5 card p.97: Mythos 5 29.7% without safeguards → 0% with updated layered safeguards; Opus 4.8 card pp.80–82: thinking sometimes *increases* susceptibility on this surface). Model robustness is necessary but not sufficient; the harness must carry defenses.

- **S1 — Quarantine.** All fetched/search content enters prompts inside provenance-tagged delimiters; system prompts instruct models that delimited content is data and any instructions within are to be reported, not followed. Acknowledged as insufficient alone; layered with S2–S4.
- **S2 — Tool firewall.** Workers that consume fetched content get read-only research tools only (search, fetch). No shell, no code-exec, no user-credentialed tools downstream of untrusted content. Code-exec (for data analysis) is opt-in, sandboxed, and receives only ledger-structured data, never raw fetched text.
- **S3 — URL guard (SSRF + exfiltration).** Outbound fetch URLs: scheme allowlist (http/https), private/link-local IP ranges blocked (post-DNS-resolution), no embedded credentials, length cap, per-domain rate limits, and a query-param entropy heuristic on never-before-seen domains (flags context-exfiltration-via-crafted-URL); flagged URLs require `safety.allowFlaggedUrls` or are dropped with a `safety.flag` event.
- **S4 — Injection screening hook.** Built-in heuristic screen (instruction-pattern detection in fetched content) emitting `safety.flag`; pluggable classifier interface for deployments that have one. Flagged sources are demoted to `unreliable` and their claims require corroboration.
- **S5 — Crawl hygiene.** robots.txt respected by default (override is an explicit config with documented responsibility shift); per-domain concurrency 1 and politeness delays; identifying User-Agent; no paywall circumvention in core (Steel Profiles auth is user-owned and user-configured).
- **S6 — Refusal/fallback handling.** Provider refusals are structured events, not crashes. Safety-classifier fallback is a documented reality on frontier models (Fable 5: 20.9% of Terminal-Bench trials fell back to Opus 4.8 mid-trajectory, card p.255; security/bio-adjacent research topics will trigger it). Config: `models.fallback?: LanguageModel[]` chain per role; every fallback emits `provider.fallback`.
- **S7 — Person-research guardrail.** Researching private individuals is refused by default (`safety.allowPersonResearch` opt-in with documented obligations); frontier models occasionally comply with dossier-building (Fable 5 card p.90) — the harness should not facilitate it silently.
- **S8 — Read-only invariant.** No Atlas tool mutates external state. Enforced at the tool registry: core registers no state-changing tools, and user-supplied extra tools must be explicitly marked `unsafe: true` to be reachable from worker agents (they are never reachable from extraction/verification agents).
- **S9 — Source-quality defense.** Trust tiering (primary/institutional > established media > blog > forum/content-farm heuristics) influences corroboration requirements (§5.5) and synthesis weighting; SEO-farm preference is a documented agent failure mode (Anthropic, 2025-06).

## 10. Evaluation harness (in-repo, release-gating)

`packages/evals`, runnable by anyone with API keys: `pnpm eval --suite smoke|nightly|release`.

| Suite | Contents | Cost | When |
|---|---|---|---|
| smoke | 5 SealQA + 10 golden citation-binding cases, recorded fixtures (VCR-style cassettes for search/fetch) | ~$0 (cassettes) – $2 live | every PR |
| nightly | 40 SealQA (noise robustness) + BrowseComp-Plus slice n=60 (frozen corpus) + citation golden set n=200 | ~$30–80 | nightly |
| release | + DeepResearch Bench RACE subset n=30 (configurable judge) + DRACO-style rubric n=25 + cost/latency curves per effort tier | ~$150–400 | per release |

- **Release gates:** citation-binding support ≥95% on golden set; no metric regresses >2 points vs last release at equal model+effort; cost p50 within published envelope ±25%.
- **BENCHMARKS.md** auto-generated per release: scores, $/run, latency, per-model matrix (Fable 5, Opus 4.8, Sonnet 4.6, GPT-5.x, Gemini 3.x, one strong open-weights model). Publish to leaderboard.steel.dev.
- **Anti-contamination:** eval runs apply URL blocklists to searcher and fetcher + transcript audit for answer-leak retrievals, re-graded as incorrect (the system cards' own methodology, Fable 5 card pp.266, 319).
- **Failure audit:** quarterly manual DEFT-style taxonomy pass over 50 sampled runs; findings become issues.
- **Methodology note:** grade only the final deliverable (`<result>`-span isolation), judge choice documented (it shifts absolute scores 10–25 points; orderings are what matter).

Launch quality bar (honest, checkable): beat gpt-researcher and LangChain open_deep_research on the RACE subset and citation accuracy **under identical model + budget**; SealQA within 3 points of the model's harness-free ceiling; publish losses as openly as wins.

## 11. Packaging and distribution

- Monorepo (pnpm + turbo): `packages/atlas` (core; zero runtime deps beyond `ai` + zod + undici + pdf parser), `packages/evals`, `examples/{nextjs,cli,trigger,inngest}`, `docs/`.
- Single npm package with subpath exports: `@steel-dev/atlas`, `@steel-dev/atlas/search/tavily`, `@steel-dev/atlas/fetch/steel`, etc. Search adapters are REST-over-fetch (no vendor SDKs); `steel-sdk` is an optional peer dependency loaded lazily.
- Apache-2.0 (matches steel-browser; patent grant matters for corporate adoption).
- Semver; `0.x` until release gates have held for two consecutive releases; **trace/event schemas carry their own versions** and follow compatibility rules from `0.1`.
- Docs: quickstart (two-liner), product integration guide (events → UI), durability guide, provider guides, safety page (threat model stated plainly), benchmark page, "how it works" with the ledger/verification design.
- Examples are marketing: a polished Next.js research app with streaming UI + citations hover-cards; a CLI (`npx @steel-dev/atlas "question"`).

## 12. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0** (wks 1–3) | Engine substrate (agent calls, fan-out, journal, cost meter), basicFetch + 2 search adapters + modelNativeSearch, single-loop lead researcher, simple report writer, CLI, smoke evals w/ cassettes | end-to-end run on 20 questions; resume works in-process; smoke suite green |
| **M1** (wks 4–8) | Ledger + verification V0–V2 + citation binding, effort/budget tiers, events API, `steel()` fetch, eval nightly suite, BENCHMARKS.md v1 | citation gate ≥90% (provisional); beats gpt-researcher on RACE subset at equal model+budget; 3–5 design partners embedding via events API |
| **M2** (wks 9–14) | Resume across processes (fileStore), structured output, clarify hook, trust policy, V3 counter-search, durability examples, docs site, safety hardening (S1–S9 complete) | public launch with benchmark table + cost curves; citation gate ≥95% |
| **v1.0** (quarter 2) | SourceProvider (documents + MCP), deepFetch interactive mode, multi-model role presets, trace schema stability promise, leaderboard automation | two consecutive gated releases; ≥3 production products embedding |

## 13. Open questions

1. **Name.** Blocking for anything public (§1.1).
2. Default search when no native tool and no key configured — fail loudly (current spec) vs bundled SearXNG instructions vs a Steel-proxied free tier (business decision; free tier creates abuse surface).
3. Verifier-model defaults: ship opinionated cross-vendor presets (e.g., Anthropic verify role on Opus-class abstention calibration) or stay neutral?
4. Embedding-based claim dedup (better merges) vs zero-embedding-dependency purity (current spec says no embeddings in core).
5. Python port timing (gpt-researcher's audience) — post-v1, or never (TS-first identity)?
6. Hosted Atlas API on Steel cloud — explicitly out of scope here, but the trace/journal design should not preclude it.
7. How aggressively to default `steel()` escalation when a Steel key is present — auto-escalate on block vs explicit opt-in (conversion vs surprise-billing tension; current lean: auto-escalate with `budget.maxUSD` respected and per-escalation events).

## Appendix A — Disposition of the reverse-engineered Claude Code workflow

Source: `claude-code/deep-research.workflow.js` (scope → 5 search angles → URL-dedup → ≤15 fetch/extract → 3-vote verify top-25 → synthesize; ~97 agent calls/run, ~75% spent on votes).

| Element | Disposition | Where |
|---|---|---|
| Claim ledger w/ verbatim quotes, source quality, importance | **Kept**, extended (status lifecycle, corroboration, trust tiers) | §5.4 |
| Adversarial votes w/ abstain-handling (all-abstain ≠ survive) | **Kept** as V2; made effort-tiered instead of flat | §5.5 |
| Default-refute-if-uncertain | Kept for central claims only (was killing contested-but-valuable findings) | §5.5 |
| URL normalization + dedup + dupes/budget-dropped accounting | **Kept** (no-silent-caps principle) | §5.4, §3.6 |
| Salvage paths (synthesis failure → raw verified claims) | **Kept**, generalized (graceful budget exhaustion) | §7 D4 |
| Stats block | **Kept**, expanded into `RunStats` | §4.5 |
| Clarify-before-research guidance in `whenToUse` | **Kept**, promoted to first-class API hook | §4.2 |
| Single-pass, breadth-only, fixed 5 angles | **Replaced** by iterative lead loop w/ saturation stop | §5.3 |
| Blocking fan-out shape | **Replaced** by async workers (Fable 5 card §8.15 evidence) | §5.3 |
| Flat 3×25 verification tax | **Replaced** by tiered verification | §5.5 |
| Claim-local-only verification (final report unchecked) | **Replaced**: citation binding pass over the deliverable | §5.7 |
| Query-independent constants | **Replaced** by effort tiers + lead adaptivity within caps | §5.8 |
| No PDF/JS/paywall handling | **Replaced** by fetch chain + `steel()` | §6.2 |
| Proprietary substrate (CC Workflow tool) | **Rebuilt** as the engine | §5.2 |

## Appendix B — Key evidence referenced

- Claude Fable 5 & Mythos 5 System Card (2026-06-09): agentic search §8.14 (BrowseComp 88.0/93.3, HLE-with-tools 64.5, DeepSearchQA 94.2 F1, DRACO 86.4; effort curves); multi-agent harness comparison §8.15 (async > blocking on accuracy/latency/tokens); prompt injection §5.2 (browser-use raw ASR 29.7% → 0% with layered safeguards); real-session failure taxonomy §2.3.3 (unverified-claims-as-fact 41/886); classifier fallback (Terminal-Bench 20.9% mid-trajectory).
- Claude Opus 4.8 System Card (2026-05-28): DRACO citation-quality weakness (~68.9, below Opus 4.7); abstention calibration (lowest incorrect-rate via abstaining); browser-use injection w/ thinking 62.8% scenarios without safeguards → ~0% with.
- Anthropic, "How we built our multi-agent research system" (2025-06): orchestrator-worker, +90.2% over single-agent, 4×/15× token economics, token spend ≈ 80% of variance, explicit effort-scaling prompts, SEO-farm failure mode, ~20-query eval starts.
- DeepTRACE (arXiv:2509.04499): 40–80% citation accuracy across deep-research products; one-sidedness on leading questions. CJR Tow Center (2025-03): >60% citation errors. FACT/DeepResearch Bench (arXiv:2506.11763): citation-accuracy methodology.
- Tongyi DeepResearch (arXiv:2510.24701): IterResearch workspace reconstruction, Heavy-mode test-time scaling. Kimi-Researcher (2025-06): 50+ iteration trajectories, context management ablations.
- Landscape (live, 2026-06-10): npm `ai` 14.2M DL/wk; `deepagents` 165k npm / 1.2M PyPI; research-specific TS packages ≤27 DL/wk; Stagehand 23k★ / 1.0M DL/wk; Browserbase Search/Fetch APIs shipped 2026-03/04 without an OSS research library; Firecrawl `/deep-research` deprecated 2025-06-30; Gemini Deep Research API at plain token rates; o3/o4-mini-deep-research $10/$40 / $2/$8 per MTok; Perplexity sonar-deep-research ~$0.40–1.30/query.
