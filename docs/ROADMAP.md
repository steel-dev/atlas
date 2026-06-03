# Atlas Roadmap

## Thesis

> Move complexity out of the agent graph and into tool primitives and measurement.
> Anthropic's DRACO 80.4% came from a single agent + strong tools (programmatic tool
> calling, code execution) at max effort — not from orchestration. Atlas's measured
> weakness was precision loss *created by* its own graph (lossy join, compaction,
> previews), not a lack of orchestration.

## Established facts (DRACO, Opus 4.6 judge, per-criterion, coverage 100%)

| Finding | Detail |
| --- | --- |
| "60% is terrible" was a measurement artifact | Gemini judge + n=10. With Opus 4.6 judge: 69.4%, statistically indistinguishable from 80.4% at n=10 (CI ≈ [54, 84]) |
| Real weakness | Factual accuracy 60.6% — ~44/53 failures are "right neighborhood, wrong exact value/entity" (missing gold numbers, dates, named entities). Not hallucination |
| Loss mechanism A (pipeline) | Subagent findings truncated to 4k chars, compaction summarizes evidence, 700-char previews |
| Loss mechanism B (access) | blocked_or_thin 91 (paywalled/challenged hosts); browser fallback already runs on every direct failure but without proxy by default, and blocked browser results are accepted with only a quality warning |
| Anthropic harness reality | DRACO was single-agent. Multi-agent harnesses (§8.11) were BrowseComp/ProgramBench only, and bought latency (3× on hard tail), not much accuracy (+1.1 team / +4.2 orchestrator) |
| Steel proxy | Browser-session-only (`sessions.create({useProxy})`). There is no HTTP proxy for native fetch; "proxy" always means a proxied browser session |

## Phases

### Phase 1a — `run_code` (DONE)

Sandboxed synchronous JavaScript over the fetched-source store: `sources[]` (full
stored text), host-side `grep(pattern, opts)` with provenance
(`{source_id, url, offset, match, context}` — offsets feed `read_source`), `print`,
final-expression `result`, output capped ~8k chars. Registered as an evidence tool
(action budget, available to subagents, excluded from finalization). Advisory
("prefer", never "must") sentences added to both system prompts.

Sandbox engine: `node:vm` with sync timeout behind a single `runSandbox()` seam.
The sandbox exposes no async APIs, so model code is synchronous and the vm timeout
terminates runaway loops. **`node:vm` is not a hard security boundary**
(constructor-chain escapes from injected host functions are possible; catastrophic
regex backtracking can outrun the sync timeout). Accepted for a local dev CLI.
Upgrade path: replace `runSandbox()` body with `isolated-vm` (true V8 isolate)
without touching `execRunCode`.

Gate: re-measure with the fixed methodology (below) and compare paired per-task
against `eval-runs/draco-v2-regrade-opus46-clean.jsonl`.

### Phase 1b — source access (gated, sequential)

Reframed after code exploration: browser escalation already exists
(`extractSourceWithFallbacks` routes every failed direct fetch to the browser);
the gap is proxy and the silent acceptance of blocked browser results.

- **1b-2 (DONE, landed ahead of 1b-1):** `--proxy` now means *all* traffic. When
  `useProxy` is on, the direct tier routes through server-side
  `steel.scrape({useProxy: true})` (`scrape_proxy` in fetch diagnostics) instead
  of a bare `fetch()`; the browser fallback was already pool-proxied and search
  already renders via the browser when proxied. Exception: PDF-like URLs stay on
  direct fetch (scrape returns no binary; all 43 baseline pdf_direct fetches
  succeeded unproxied). The earlier per-flavor session-pool + blocked-retry design
  is dropped as unnecessary complexity — a single, total switch is the simpler
  mechanism-layer opinion.
- **1b-1 (measurement):** one run with `--proxy` on the same seed — now with
  honest total-proxy semantics — paired against the no-proxy run. Compare
  `choke.blocked_or_thin` (91) and factual accuracy; watch geo-sensitive domains
  (Shopping, Personalized Assistant) for regressions from proxy exit location.

### Phase 2 — Send/Wait messaging harness (DONE)

The measurement gate was consciously skipped (explicit decision to build ahead of
data); the strategic fork resolved to the **portable messaging** path —
provider-symmetric, no Anthropic-native lock-in.

- **Prerequisite (landed first, separate commit):** per-subagent budgets relaxed —
  `SUBAGENT_MAX_TOOL_CALLS` 20→40, findings handoff cap 4k→16k chars. The lead
  budget stays at 12 (measured not budget-bound).
- **Messaging (landed):** broker + per-agent inboxes (`src/messaging.ts`) behind
  `send_message` / `wait_for_message` tools on both sides, addressed by spawn
  handle with `lead` reserved. Semantics: single-consumer mailbox, FIFO by
  arrival, 8k chars per message, synchronous wake (test determinism). Inbound
  messages are injected after the recipient's next tool-result flush and once
  more before final synthesis. A parked `wait_for_message` resolves on send, on
  `no_more_senders` (every possible sender finished), on timeout (default 120s,
  clamped so a sub-agent can never park through its own synthesis reserve), on
  soft stop (resolve with note), or on hard abort (reject through the normal
  tool-error path). `join` and `settle` both broadcast a collecting note that
  frees parked sub-agents, so the lead can never deadlock against a waiting
  worker. Both tools are action-budget-free; the runaway ceiling moved from
  `maxToolCalls × 2` to `× 3` so coordination chatter cannot end a run early.
- spawn/join remain the lifecycle; messaging adds the mid-flight channel
  (redirects, incremental findings, blocking questions). Peer-to-peer sub-agent
  messaging already works mechanically — any registered handle is addressable —
  it just requires the lead to share handles. Prompts stay advisory.

## Decided against

| Item | Reason / revisit condition |
| --- | --- |
| Anthropic-native ceiling (programmatic tool calling + code execution, single strong agent) | The Phase 2 fork resolved to portable messaging; native path conflicts with the provider-symmetry investment. Revisit only if symmetry is abandoned |
| SQLite / embedded DB for the store | Regex cannot be indexed; data is non-relational prose; corpus is MBs. Revisit for a cross-run fetch cache or a truly parallel shared store in Phase 2 |
| Inverted index / vector store | Helps keyword/semantic search, not exact-pattern extraction — the measured bottleneck |
| Raising the lead tool budget | Lead uses 4.7/12 calls; it is not budget-bound |
| Fixing the subagent 4k truncation in place | Conditional — Phase 2 may remove the join entirely; the shared store + run_code already lets the lead recover precise facts by grepping |

## Backlog (trigger-gated)

- Answer-shape adaptation (Needle-style short-answer tasks tripped the only
  negative presentation penalty) — implement as prompt-level guidance, not a
  harness-side classifier.
- Alternative-hypothesis enumeration for lateral clues (homophones/puns) before
  committing subagents to one frame.
- archive.org / cache fallback and academic search + DOI resolution
  (Semantic Scholar, unpaywall) — if blocked sources remain the bottleneck after 1b.
- 5 independent grading runs averaged (full protocol parity with the system card).
- `isolated-vm` swap for `runSandbox()`.

## Measurement principles

1. **Fixed methodology:** judge `claude-opus-4-6`, per-criterion grader,
   `--judge-concurrency 2` (the account's concurrent-connection limit is below 8),
   same seed (`draco-v1`).
2. **One variable at a time** — separate commits, separate measurement runs.
3. **Measurement ladder:** fixed n=10 paired per-task deltas for fast iteration →
   confirm at n=30–50 before believing a result → n=100 for any headline number.
4. **Coverage < 90% invalidates a run** (`scoreValid` in the summary; the 73.1%
   incident — 222 judge errors silently dropped — must not recur).

Reference baseline: `eval-runs/draco-v2-regrade-opus46-clean.jsonl` — 69.4%
normalized, factual-accuracy 60.6%, coverage 100%.

Note: by skipping the Phase 1/2 gates the next no-proxy run measures the
cumulative delta (run_code + relaxed budgets + messaging), not one variable.
Per-task traces still allow post-hoc attribution: `run_code` tool events,
`message_sent` events (from/to/chars), and finish reasons are all in the JSONL.

Measurement command:

```bash
npm run eval:draco -- --sample 10 --seed draco-v1 --timeout 1800 --token-limit 4000000 --team 1 \
  --judge-provider anthropic --judge-model claude-opus-4-6 --judge-concurrency 2 \
  --out eval-runs/draco-v3-runcode.jsonl
```

## Design constitution

Opinions are allowed by layer:

| Layer | Opinions allowed? | Examples |
| --- | --- | --- |
| Mechanism / transport | Yes | Fetch fallback chain, retries, sandboxing, scheduling |
| Affordances (tools) | Yes, if optional | `run_code`, `grep` — the model may ignore them |
| Resource management | Necessary evil — keep minimal and generous | Budgets, compaction, output caps. The harmful findings (4k truncation, tight caps, fixed report format) were all hidden opinions in this layer |
| Strategy / policy | No — never in code | When to search, how to verify, report structure, delegation patterns. Prompt-level guidance stays advisory ("prefer", never "must always") |

**Model upgrade test:** if a smarter model is dropped into the harness, does it get
better automatically? Affordances pass; hard-coded policies fail. The system card
demonstrates this — the same thin harness scores higher with each model generation.
