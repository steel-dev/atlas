# Re-port `niko/surface-run-failures` onto main

## Context

Atlas silently swallows total failures. When gather or synthesis hits a hard error (unreachable/misconfigured endpoint, proxy 404, auth failure), `src/spine.ts` catches it, does nothing for non-abort errors, and falls through to a bland completed run: `"No sources could be retrieved…"` / `"…no report could be composed within budget."`, `$0` spent, `0` agents, **exit 0** — indistinguishable from a legitimately unanswerable question. This is directly costly for the proxied Z.ai setup, where a misconfigured `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` produces exactly this outcome.

The `niko/surface-run-failures` branch fixed this in 3 commits, but it forked at `f109ce9` and is 15 commits behind main on a divergent spine lineage. A `git merge`/cherry-pick is not viable (huge pointless conflicts; `04cf13b` cherry-picks to a silent no-op + 2 build breaks). The fix is still needed — every gap is confirmed present in main today — so we **re-implement the behavior by hand** off current `main`, TDD, in three independently-landable increments. All plumbing already exists on main: the `run.error` event carries a `recoverable: boolean` (`src/events.ts:83`) never yet set true, and `cli.ts`/`serve.ts` already render/forward `run.error`.

Work on a fresh branch off `main` (this branch, `surface-run-failures-v2`). Delete `origin/niko/surface-run-failures` only **after** this lands — its test files are the behavioral spec we port cases from.

## Increment 1 — Spine failure visibility (port of `6ad405a`) · value: high

Kills the silent-failure class. Smallest, highest-value, no type/API changes.

**`src/spine.ts`** — at each swallow site, capture the non-abort error, emit it, and embed the real cause:
- Add `errorMessage` to the existing `./errors.js` import (confirmed exported at `src/errors.ts:1`).
- Gather catch (`~838-842`): on non-abort error, `rctx.emit({ type: "run.error", message: errorMessage(err), recoverable: true })` and keep a `gatherError` message. The event is the **only** channel — no `process.stderr` writes from core (the branch's final commit removed them; `cli.ts:266` already renders the event, and a core write would duplicate output, bypass `--quiet`, and leak a global side effect into SDK/server consumers).
- Sibling catches — preSynthFill (`~859-861`), synthesis (`~869-873`), coverage/flush (`~889-891`): same recoverable `run.error` emission on non-abort error (preserve the existing abort re-throw conditions verbatim).
- Zero-source fallback return (`~845-853`) and empty-draft fallback return (`~893-901`): prefix/replace the generic string with the captured cause so `report`/`note` carry the real reason. Keep main's return shape (`citations`, `unboundCitations`).

**`src/spine.test.ts`** — port the branch's cases against main's harness (gather is 4-arg `gather(rctx, meter, task, ceiling)` over a shared `meter`): a simulated total gather outage emits a recoverable `run.error` and surfaces the cause in `note`; abort still re-throws; a healthy run is unchanged.

## Increment 2 — Outcome classification + exit codes + proxy warning (port of `ca8cfff`) · value: high

**`src/env.ts`** — append `detectProxyBaseURL()` + `proxyBaseURLWarning()` verbatim from the branch (already correctly scopes to `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` only, excluding app-owned Z.ai base URLs). Keep existing `readEnv`.

**`src/result.ts`** (new) — tiny types file from the branch: `ResearchFailurePhase = "gather" | "synthesis"`, `ResearchFailure { phase, message }`, plus `ResearchDegenerate { reason: string }` (not on the branch — needed so a completed-but-unusable run is classifiable without inferring from fallback text). (Pulled forward from `04cf13b` so `outcome.ts` compiles here.)

**`src/outcome.ts`** (new) — port the branch's version extended with the degenerate signal: `classifyRunOutcome({ sources, note, failure?, degenerate? })` → `{ status, exitCode, note }`; `failure` → `failed`/`FAILED_EXIT_CODE = 1`, else `degenerate` set **or** zero sources → `degenerate`/`DEGENERATE_EXIT_CODE = 3`, else `ok`/0. Structurally typed — no hard dep on `ResearchResult`. (Without the flag, "sources gathered + empty draft + no failure" would classify `ok`/0 — the classifier can't see report usability from `sources`/`note` alone.)

**`examples/cli.ts`** — import `classifyRunOutcome`; in `main()` after the run, `const outcome = classifyRunOutcome(result)`; print `footer` on `ok`, else print the cause line **plus** the stats footer (cost/duration matter most on runs that produced nothing); set `process.exitCode = outcome.exitCode` when non-zero (do **not** switch the abort/paused `process.exit(130)` paths). Rewrite `footer()` (`~339-351`) to branch on `outcome.status` using **main's** `RunStats` fields (`costUSD`, `searches`, `citationsBound`/`citationsUnsupported`, `stopReason`, `durationMs`) — the branch's `claimsConfirmed/agentsSpawned` fields do not exist on main (`src/events.ts:18-34`).

**`examples/cli.ts` + `examples/serve.ts`** — proxy warning at startup in **both** entry points (the branch wired both; branch `cli.ts:213-214` is the template), **scoped to the providers actually selected** for this run: `detectProxyBaseURL(process.env, { providers })` where `providers` derives from the resolved lead/cheap provider families — unscoped detection would warn about `OPENAI_BASE_URL` on a pure Z.ai run that never touches the OpenAI SDK. In serve.ts, near `readEnv`/`new Atlas` (`~17`/`~199-201`); log `proxyBaseURLWarning(name)` to stderr for each hit.

**Tests** — new `src/env.test.ts` and `src/outcome.test.ts` (port branch cases): `detectProxyBaseURL` flags anthropic/openai but not Z.ai; `classifyRunOutcome` returns `degenerate`/exit 3 for zero sources, `ok`/exit 0 otherwise.

## Increment 3 — Structured failure capstone (port of `04cf13b`) · value: high

Turns a zero-source **outage** (exit 1/failed) apart from a benign zero-source **result** (exit 3/degenerate).

- **`src/spine.ts`** — add `failure?: ResearchFailure` and `degenerate?: ResearchDegenerate` to `SpineOutput` (`~44-51`). In the gather fallback (`~845-853`): set `failure: { phase: "gather", message }` when a gather error was captured (the branch spreads `...(gatherError ? { failure } : {})` — unconditional would misclassify every legitimately-zero-source run as failed), else set `degenerate: { reason: "no sources retrieved" }`. In the empty-draft fallback (`~893-901`): set `failure: { phase: "synthesis", message }` when a synthesis error was captured (deviation from the branch, which sets it unconditionally — see Decisions), else set `degenerate: { reason: "no report composed within budget" }`.
- **`src/run.ts`** — add `failure?: ResearchFailure` and `degenerate?: ResearchDegenerate` to `ResearchResult` (`~58`) and propagate `out.failure`/`out.degenerate` into the assembled `result` (`~334`).
- **`src/index.ts`** — export `ResearchFailure` (and `RunOutcome`/`classifyRunOutcome` if we want them public).
- **`examples/cli.ts`** — `classifyRunOutcome` now reads `result.failure` → `FAILED_EXIT_CODE` and `result.degenerate` → `DEGENERATE_EXIT_CODE`; relabel recoverable `run.error` as `"warning:"` in the event renderer (`~266-269`).
- **`examples/serve.page.html`** — mirror the recoverable→"warning" label in the SSE `run.error` handler; while in this file, fix `finish()` (`~119-125`), which renders `stats.claimsConfirmed`/`claimsContested`/`claimsRefuted`/`agentsSpawned` — fields that don't exist on main's `RunStats`, so the page prints "undefined" today. Rebuild it on the real fields (`costUSD`, `searches`, `citationsBound`/`citationsUnsupported`, `stopReason`, `durationMs`), matching the CLI footer.
- **Tests** — extend `spine.test.ts`/`outcome.test.ts`: gather/synthesis outage sets `failure` and classifies `failed`/exit 1; zero-source-no-error sets `degenerate` (no `failure`) and classifies `degenerate`/exit 3; sources-gathered-but-empty-draft with no synthesis error (budget exhaustion) sets `degenerate` and classifies `degenerate`/exit 3.

## Reuse (don't reinvent)

- `rctx.emit` — already used across `spine.ts` for other events; reuse for `run.error`.
- `run.error` event with `recoverable` — `src/events.ts:83`; already rendered in `cli.ts:266-269` and forwarded to SSE in `serve.ts:155`.
- `errorMessage` (`src/errors.js`) / `messageOf` (`serve.ts`) — for cause extraction.
- `readEnv` (`src/env.ts`) — extend in place.
- Branch source is portable near-verbatim for `env.ts` helpers, `outcome.ts`, `result.ts`; only spine/cli/serve wiring is hand-ported.

## Decisions taken (flagging, not blocking)

- **Exit-code convention kept from the branch**: `0` ok, `3` degenerate (ran clean, no sources), `1` failed (real outage). The 3-vs-1 split is deliberate so scripts can tell "nothing found" from "it broke." Collapse both to `1` if preferred.
- **Runs still complete** on recoverable failures — visibility is via the `run.error` event (rendered to stderr by the CLI) + note + exit code, not a thrown error. Matches main's existing recoverable/terminal `run.error` split.
- **Deviation from the branch on empty-draft classification**: the branch sets `failure` unconditionally in the empty-draft fallback, so a draft that's empty purely from budget exhaustion (no synthesis error) exits 1 `failed` — conflating "budget too low" with a real outage. We set `failure` only when a synthesis error was captured; budget-exhausted empty drafts carry the structured `degenerate` flag and exit 3.
- **Scope: default spine only.** Orchestrated runs (configured researchers, `src/run.ts:292`) reconstruct child output without `failure` (`src/orchestrate.ts:221-245`), and an all-researchers-failed run returns a nonempty fallback report with `sources: []` — it would classify `degenerate`, not `failed`. Neither shipped entry point configures researchers, so orchestration propagation is deliberately out of scope; logged as a follow-up (aggregation semantics — one child failed vs. all — need their own design).
- **"Outage" means model-call failure.** Search-provider exceptions are converted to warnings + empty result lists (`src/providers/search.ts:574-577`) and fetch errors to normal tool-error results (`src/tools.ts:869`), so gather doesn't throw for acquisition outages — a total search outage exits 3 with warnings, not 1. The motivating bad-base-URL case is a model-endpoint failure and does exit 1. Structural "all acquisition attempts failed" tracking is a possible follow-up, not in scope.

## Verification

- **Unit**: `npm run test:run` (CI parity — bare `npm test` is vitest watch mode) — new/updated `src/env.test.ts`, `src/outcome.test.ts`, `src/spine.test.ts`. Test output must be pristine.
- **Typecheck/build**: `npm run typecheck` + `npm run build` green on Node 20 and 22 (main's CI matrix). Note `examples/tsconfig.cli.json` includes only `cli.ts` — add `serve.ts` to its `include` so the server wiring is typechecked too, and smoke-start the server once (`node --experimental-strip-types examples/serve.ts` or the repo's usual invocation) to confirm it boots. `examples/` sit outside `tsconfig` rootDir, so the new logic lives under `src/` (pure, unit-tested) with thin wiring in `examples/`.
- **E2E (manual, real APIs)**:
  1. *Outage path* — run the CLI with a valid key but a bogus `ANTHROPIC_BASE_URL` (or `--provider zai` + broken `ZAI_BASE_URL`): expect a recoverable `run.error` warning, the real cause in the note, and `echo $?` = **exactly 1** ("1 or 3" would pass the very regression increment 3 exists to prevent).
  2. *Degenerate path* — a healthy run on a question where nothing usable is found (or budget too low to compose): exits **exactly 3**.
  3. *Proxy warning* — run the CLI and start `serve.ts` with `ANTHROPIC_BASE_URL` set (anthropic provider active): expect the startup proxy warning in both; set only `ZAI_BASE_URL`, or `OPENAI_BASE_URL` on a Z.ai run: expect **no** warning.
  4. *Happy path* — a normal healthy query still prints the green footer and exits 0.
- Commit per increment (conventional-commit style); no `--no-verify`; fix any pre-commit hook failures at the root cause.

## How this report was produced

Branch topology and every code anchor above were verified against `main` at commit `7aea679` and against `origin/niko/surface-run-failures`. A multi-agent workflow dissected the three branch commits, mapped main's current spine/cli/serve/env, produced per-commit verdicts, and adversarially verified each against main's actual code; the load-bearing claim (main's gather catch still silently swallows non-abort errors) was additionally confirmed by hand.

Two subsequent review passes tightened the plan: conditional `failure` classification with a structured `degenerate` signal (the classifier can't infer report usability from `sources`/`note`), CLI+scoped proxy-warning wiring restored from the branch, no core stderr writes, orchestration and acquisition-outage scope made explicit, exact exit-code E2E criteria, and serve.ts brought under typecheck.
