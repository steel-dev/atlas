---
name: atlas-optimize
description:
  Diagnose an atlas run's efficiency — find where wall-clock, model wait, and
  cost actually went, tie each bottleneck back to the src/*.ts function that owns
  it, and propose concrete performance fixes. Reads the bottleneck digest, timing
  spans, and byte-exact transcript captured by `--trace`. Use when the user asks
  to "analyze this commit's run traces", find why a run is slow or expensive,
  investigate a latency or cost regression, or optimize a research query.
  Read-only: it diagnoses and proposes file:line fixes; it does not edit code.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# atlas-optimize

The efficiency counterpart to `draco-analyze`. That skill asks *did the research
score well*; this one asks *where did the time and money go, and which function
should change*.

It reads the trace `--trace` captures for a run: per-call / per-agent / per-phase
**timing spans** (with a compute-vs-gate-wait split), an automatic **bottleneck
digest** (critical path, phase + per-agent rollups, concurrency peaks, ranked
anomalies), and the **byte-exact model transcript** — every step's system prompt,
input thread, thinking, and tool calls. Crucially the digest carries an
`attribution` map (`site → src/file.ts:fn`), so every hot span points straight at
the code that owns it. That map is the whole reason this is a skill and not an
SDK feature: a finding maps to a file you can open and read.

## Producing a trace

A run only emits a trace when started with `--trace`. Traces land under
`eval-runs/traces/<commit>/` (git-ignored), one pair of files per run:
`<runId>.digest.json` (small) and `<runId>.trace.json` (spans + transcript).

```bash
tsx examples/cli.ts "<question>" --trace full --effort balanced
```

- `--trace full` = spans + verbatim transcript. `--trace spans` = the lighter
  tier (timing + digest, no verbatim I/O) — enough for bottleneck work, cheaper
  to keep.
- If the user names a question to optimize and no trace exists, **offer** to run
  this and proceed only on confirmation — it spends provider + Steel credits.
- If they say "analyze this commit's traces", read what's already on disk; don't
  re-run.

## Reading traces — one keyless CLI

All reads go through `tsx examples/trace.ts`. The data is large, so the rule is
**progressive disclosure**: start at the digest, descend only as far as the
question needs. Never dump a full transcript blind — slice it.

```bash
tsx examples/trace.ts commits                 # commit dirs that have traces
tsx examples/trace.ts list [--commit SHA]     # runs for a commit (default HEAD): wall/cost/waitRatio/peak/top anomaly
tsx examples/trace.ts digest <runId>          # the bottleneck digest — START HERE
tsx examples/trace.ts spans <runId> [--kind model|tool|io|agent] [--grep RE]
tsx examples/trace.ts transcript <runId> [--role R] [--seq A-B] [--step N] [--grep RE] [--head N] [--messages]
```

Output is JSON (transcript renders text); parse it, don't echo it at the user.

## Step 0 — Resolve the commit and the runs

If the user gave a runId, use it. Otherwise default to the current commit
(`git rev-parse --short HEAD`) and `list` its runs; say which you used. If the
commit has no traces, say so and offer to produce one. With several runs of the
same question, treat them as repeated samples — timing varies run to run.

## Step 1 — Read the digest (the headline)

```bash
tsx examples/trace.ts digest <runId>
```

Read off, in order:

- `criticalPath` + `criticalPathMs` — the chain of spans that actually fills the
  wall clock. **This is where time went.** Each entry carries its `site`.
- `waitVsCompute` — `{ computeMs, waitMs, ratio }`. ratio ≫ 1 means most model
  time was spent **queued for the gate**, not computing.
- `concurrency` — `peakModelInFlight` vs `gateLimitModel`. Peak pinned at the
  limit *and* high wait ⇒ gate-starved.
- `anomalies` — pre-ranked by severity; each has a `site` and a `detail`.
- `phaseBreakdown` (keyed by site) and `byAgent` — where wall / compute / cost /
  tokens concentrate. `byAgent` splits `selfMs` (own model time) from
  `subtreeMs` (incl. children).
- `topByWait` / `topByLatency` / `topByCost` — the worst individual model calls.
- `attribution` — `site → src/file.ts:fn`. **This is your jump table to code.**

## Step 2 — Symptom → cause → source

| digest signal | likely cause | drill | fix lives in |
| --- | --- | --- | --- |
| `waitVsCompute.ratio` high + `peakModelInFlight == gateLimitModel` | model-gate starvation — work oversubscribes the concurrency cap | `spans --kind model`, `topByWait` | `src/config.ts` (maxConcurrentModelCalls) + the fan-out flooding it |
| `high-wait` anomalies clustered at one `site` | that phase queues behind everything else | `spans --grep <site>` | `attribution[site]` |
| `slow-step` anomaly, low wait | model-bound: prompt too large or maxTokens too high | `transcript --seq <n> --messages` | `attribution[site]` |
| `redundant-call` anomaly | identical fresh call issued >1× — duplicated spend | `spans --grep <callKey8>` | `attribution[site]` (missing memoization) |
| `tail-agent` anomaly | one leaf agent is the long pole in a `Promise.all` | `byAgent`, `transcript --role <agentId>` | `src/agent.ts` / the spawn fan-out |
| `retry-storm` anomaly | backoff from rate limits / 429s, not gate wait | `spans --grep <site>` | provider concurrency / `src/config.ts` |
| large `idleMs` | serialization gap — an await that could overlap | `criticalPath` (look for idle jumps) | the awaiting call site |
| one `site` dominates `phaseBreakdown` / `topByCost` | that phase is the spend driver | `phaseBreakdown`, `transcript --role` | `attribution[site]` |

Always resolve the file from the digest's own `attribution` map — don't guess the
filename from the site name.

## Step 3 — Drill only where a hypothesis needs it

```bash
tsx examples/trace.ts spans <runId> --kind model --grep verify     # one phase's calls: waitMs, computeMs, cost
tsx examples/trace.ts transcript <runId>                            # summary: steps per role
tsx examples/trace.ts transcript <runId> --role lead               # the lead's reasoning + tool calls
tsx examples/trace.ts transcript <runId> --seq 8-10 --messages     # byte-exact input for a step range (large)
```

Use the transcript to answer what the aggregates can't: *why is this call's
prompt so big? what is this agent re-reading every step? did synthesis get handed
redundant context?* Then open the attributed source and read it before proposing
anything.

## Step 4 — Synthesize: bottlenecks → fixes

Produce, for the user:

1. **Ranked bottlenecks** — each tied to a digest signal (quote the number:
   `waitMs`, share of `criticalPathMs`, `costUSD`), the root cause, and the
   `src/file.ts:fn` it lives in (from `attribution`).
2. **A concrete fix per bottleneck** — read the file first, then cite `file:line`
   and the change. Separate *config* fixes (a knob in `config.ts`, low-risk) from
   *structural* fixes (a pipeline change — overlap awaits, memoize a call, trim a
   prompt, rebalance fan-out).
3. **Cross-run patterns** — if several runs on this commit show the same hot
   site, that's the highest-leverage fix; a site that's hot in one run but not
   others is variance, not a bug.

## Step 5 — Close the loop (verify a fix)

After a fix is applied (by the user, or in a normal edit turn — **not** under this
skill), confirm it moved the needle:

```bash
tsx examples/cli.ts "<same question>" --trace full --effort <same>
tsx examples/trace.ts digest <newRunId>
```

Diff the new digest against the old: did `criticalPathMs` / `modelWaitMs` /
`costUSD` drop, did the anomaly clear, and where did the bottleneck move next
(it usually moves — name the new long pole)? If `src/` changed, confirm
`npm run test:run` is green. Report before/after numbers, not just "fixed".

## Boundaries

- **Read-only.** This skill diagnoses and proposes; it does not edit `src/`. Hand
  off each fix as `file:line` + the change. If asked to apply it, do so in a
  normal turn, not under this skill.
- **Progressive disclosure.** Start at `digest`; slice `spans` / `transcript`.
  Never dump a whole transcript to reach a conclusion.
- **Replayed work isn't a bottleneck.** Replayed calls have zeroed timing and
  `status:"replayed"`; the digest already excludes them from latency math — don't
  re-introduce them as if they cost wall-clock.
- **Honor variance.** Timing shifts with network and provider load. One run is a
  hypothesis; if numbers swing across runs of the same question, say so rather
  than over-fitting a story to a single run.
- **Ground every claim.** Quote the digest field, the span's `waitMs`/`computeMs`,
  the transcript line, or the `file:line` you cite. If the trace can't decide, say
  what's missing (e.g. "this run was `--trace spans`; need `full` to see the
  prompt").
- **Mind cost.** Producing a trace runs real research. Re-run to verify only when
  it earns the spend; prefer reusing the commit's existing traces.
