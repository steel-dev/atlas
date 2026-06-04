# Atlas Roadmap

## Thesis

> Move complexity out of the agent graph and into tool primitives and measurement.
> Anthropic's DRACO 80.4% came from a single agent + strong tools (programmatic tool
> calling, code execution) at max effort — not from orchestration. Atlas's measured
> weakness was precision loss *created by* its own graph (lossy join, compaction,
> previews), not a lack of orchestration.

The thesis held but the conclusion inverted. The earlier bet — thin harness, advisory
prompts, strategy never in code — left every failure mode (lazy stops, self-preferential
verification, goal drift after compaction) live in a single long context window. The
current architecture moves the strategy *into deterministic code* and keeps the model's
intelligence for content decisions (which angles, which queries, which claims, which
verdicts). The agent graph is gone; an evidence contract takes its place.

## Established facts (DRACO, Opus 4.6 judge, per-criterion, coverage 100%)

| Finding | Detail |
| --- | --- |
| "60% is terrible" was a measurement artifact | Gemini judge + n=10. With Opus 4.6 judge: 69.4%, statistically indistinguishable from 80.4% at n=10 (CI ≈ [54, 84]) |
| Real weakness | Factual accuracy 60.6% — ~44/53 failures are "right neighborhood, wrong exact value/entity" (missing gold numbers, dates, named entities). Not hallucination |
| Loss mechanism A (pipeline) | Subagent findings truncated to 4k chars, compaction summarizes evidence, 700-char previews — every one a place an exact value could be dropped |
| Loss mechanism B (access) | blocked_or_thin 91 (paywalled/challenged hosts); browser fallback runs on every direct failure but blocked results were accepted with only a quality warning |
| Anthropic harness reality | DRACO was single-agent. Multi-agent harnesses bought latency (3× on hard tail), not much accuracy (+1.1 team / +4.2 orchestrator) |
| Steel proxy | Browser-session-only. "proxy" always means a proxied browser session; there is no HTTP proxy for native fetch |

## Architecture

One fixed lifecycle, no modes. Width contracts to the question (1 angle for a narrow
lookup, up to 6 for a broad one) so the same path serves both.

```
Scope → Recall (search → dedup → fetch → extract) → Gap-chasing lead → Verify → Synthesize
```

- **Evidence contract (`claims.ts`).** Every fetched source — from recall, a survey, or a
  direct lead fetch — is queued for one-shot extraction into a claim ledger. A claim is a
  falsifiable statement plus a quote that is *mechanically* string-matched against the
  stored source text (0 tokens); paraphrased or hallucinated quotes are dropped before any
  model sees them. This is the direct fix for loss mechanism A: exact values are pinned at
  extraction, not transcribed through summaries.
- **Recall prologue (`recall.ts`).** Scope picks angles; the search provider is called
  directly (no per-angle agent), URLs dedup against the store, the top sources fetch under
  a global budget. The ledger fills before the lead ever runs.
- **Gap-chasing lead (`research-loop.ts`).** The lead starts holding a ledger digest and
  closes gaps with `survey` (search + fetch + extract in one call), `fetch`, or the
  `browser_*` tools. When the transcript grows past a threshold it **re-anchors** —
  discards the transcript and rebuilds from the current ledger — so goal drift after
  compaction (loss mechanism C) cannot accumulate; the ledger is durable state.
- **Adversarial verify (`verify.ts`).** Each ranked claim faces three independent voters on
  distinct lenses (quote fidelity, contradiction search, source strength), refute-by-default,
  two refutations to kill, a quorum of valid votes required to survive. This runs regardless
  of what the lead did, so self-preferential bias and lazy stops cannot reach the report.
- **Synthesis (`synthesize.ts`).** Written only from confirmed claims; refuted claims are
  shown to the synthesizer purely so it does not resurrect them.

Loss mechanism B is handled at the contract edge: thin/blocked/listing sources are graded
`unreliable` at extraction and never enter the ledger as evidence.

### Landed

- Repo hygiene; build now cleans `dist`.
- Claim ledger with verbatim quote verification.
- Adversarial verify + synthesis stages.
- Recall prologue and `survey` tool.
- Single lifecycle: removed `subagents.ts`, `messaging.ts`, `compaction.ts`,
  `structured-output.ts`, `research-tool.ts`, the `plan`/`digest_source`/`spawn`/`join`/
  messaging tools, and their config/env surface.
- Shared eval lib; DRACO + BrowseComp re-pointed at the claim-based event vocabulary.

### Next

- Re-measure against the reference baseline (see below). The architecture changed wholesale,
  so this is a fresh number, not a one-variable delta.
- Tune the fixed constants (`VOTES_PER_CLAIM`, `REFUTATIONS_REQUIRED`, fetch/verify caps,
  voter-lens prompts) on the measurement gate once a baseline exists.
- Clone-vs-lens A/B for the verifier panel: three identical refuters vs the three distinct
  lenses currently shipped.
- `leafModel` routing: send the high-volume extraction/voter calls to a cheaper model and
  measure the accuracy/cost trade.

## Decided against

| Item | Reason / revisit condition |
| --- | --- |
| Mode split (pipeline vs loop) | Rejected up front — routing is a new failure point and splits the eval. One lifecycle whose width contracts to 1 covers the narrow case |
| Portable messaging / spawn-join graph | The whole reason for the rewrite. Re-derived the same failure modes Anthropic's workflows post names (laziness, self-preference, drift) and removed the graph that caused them |
| Structured-output evidence validation (BrowseComp) | Coupled to the removed `output` path; BrowseComp now grades on markdown answer extraction + judge |
| Inverted index / vector store | Helps keyword/semantic search, not exact-pattern extraction — the measured bottleneck |
| Dynamic (model-authored) harness | Not needed to beat DRACO: a well-tuned fixed lifecycle suffices, and a fixed harness is what makes regression measurement possible |

## Measurement principles

1. **Fixed methodology:** judge `claude-opus-4-6`, per-criterion grader,
   `--judge-concurrency 2`, same seed (`draco-v1`), max effort (adaptive thinking +
   `effort: "max"`).
2. **One variable at a time** once a post-rewrite baseline exists — separate commits,
   separate runs.
3. **Measurement ladder:** n=10 paired per-task deltas for fast iteration → confirm at
   n=30–50 → n=100 for any headline number.
4. **Coverage < 90% invalidates a run** (`scoreValid` in the summary).

Reference baseline (pre-rewrite): `eval-runs/draco-v2-regrade-opus46-clean.jsonl` — 69.4%
normalized, factual-accuracy 60.6%, coverage 100%. The first post-rewrite run measures the
cumulative architecture change against it. Per-task attribution lives in the JSONL:
`claims_extracted` / `claim_verified` events, survey counts, re-anchor counts, and finish
reasons.

Measurement command:

```bash
npm run eval:draco -- --sample 10 --seed draco-v1 --timeout 2700 --token-limit 4000000 \
  --judge-provider anthropic --judge-model claude-opus-4-6 --judge-concurrency 2 \
  --out eval-runs/draco-v3-lifecycle.jsonl
```

## Design constitution

The earlier constitution forbade strategy in code and kept the harness thin. The rewrite
overturns that: strategy lives in deterministic code precisely so the model cannot drift,
stop early, or grade itself. The line that still holds is *where the model's intelligence
goes*.

| Layer | In code? | Examples |
| --- | --- | --- |
| Lifecycle / orchestration | Yes — fixed, deterministic | Scope → recall → gap-chasing → verify → synthesize; budgets, dedup, ranking, quorum |
| Evidence contract | Yes — enforced | Claim state machine, mechanical quote verification, source-quality gating |
| Content decisions | No — the model's job | Which angles, which queries, which claims and quotes, which verdicts, the report prose |
| Affordances (tools) | Optional | `survey`, `run_code`, `browser_*` — the lead chooses when to use them |

**Model upgrade test:** a smarter model should improve every content decision (sharper
angles, better claims, stricter verdicts) while the lifecycle that guarantees recall and
precision stays fixed underneath it.
