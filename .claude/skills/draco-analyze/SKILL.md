---
name: draco-analyze
description:
  Diagnose the DRACO benchmark results for an atlas commit — figure out why
  cases scored as they did and propose concrete atlas improvements, drilling from
  a commit overview down to per-criterion grades, claims, sources, and the
  byte-exact model transcript. Use when the user asks to "analyze this commit's
  benchmark", investigate a score regression, or work out why a DRACO case failed
  or underperformed. Read-only: it inspects stored runs, it does not run the
  benchmark.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# draco-analyze

Diagnose a commit's DRACO benchmark runs and connect each finding back to the
atlas pipeline so the user gets root causes and concrete fixes, not just scores.

Every run the explorer records is fully visible: the per-criterion judge grades,
the produced report, the full claim ledger (with quotes, source provenance, and
each verifier's vote), every fetched source's body, the pipeline event timeline,
and the **byte-exact transcript of every model step** (lead, verifiers, leaf
sub-agents) — what each model saw and the thinking + tool calls it produced. Runs
are append-only, so repeated runs of the same case all survive.

All of this is read through one keyless CLI (`evals/explore/query.ts`). The data
is large, so the golden rule is **progressive disclosure**: start from the cheap
overview and descend only as far as a given question needs. Never dump a full
transcript blind — slice it.

## Step 0 — Confirm the repo and find the DB

```bash
test -f evals/explore/query.ts && test -f package.json && echo ok || echo not-atlas
```

If `not-atlas`, ask the user to `cd` into the atlas repo and re-run. The DB
defaults to `eval-runs/draco-explore.db`; pass `--db <path>` to every command if
the user names a different one. (Commands print a harmless
`ExperimentalWarning: SQLite` to stderr — ignore it, or append `2>/dev/null`.)

The query CLI is invoked as `npx tsx evals/explore/query.ts <command> …`. Run it
with no args for the full command list. Output is JSON; parse it, don't just echo
it at the user.

## Step 1 — Resolve the commit and read the overview

If the user gave a commit SHA, use it. Otherwise default to the checked-out one
(`git rev-parse HEAD`) and say which you used.

```bash
npx tsx evals/explore/query.ts commits                      # all commits with runs
npx tsx evals/explore/query.ts commit <sha>                 # per-case grid, Δ vs previous commit
```

`commit <sha>` auto-compares against the previous commit; pass
`--baseline <otherSha>` to compare against a specific one (e.g. a known-good
reference). Read off:

- `regressions` — cases whose score dropped vs the baseline. **These are usually
  where to start.**
- per-case `normalized`, `passRate`, `failedCriteria` (count), `status`
  (`scored` / `error` / `unrun`), `judgeErrors`.

Pick the highest-value targets: the biggest regressions, hard errors, and
unexpectedly low scores. State your shortlist before drilling.

## Step 2 — Diagnose each target case

```bash
npx tsx evals/explore/query.ts case <sha> <caseId>
```

This is the richest single view. It fuses the rubric with the judge's grades and
the run's evidence:

- `failedCriteria` — exactly which rubric criteria got **UNMET**, with the judge's
  `reason`. This is your primary signal for *what* went wrong.
- `score`, `claimStats` (confirmed / refuted / unverified), `diagnostics`
  (fetch/claim health), `finishReason` (did it run out of budget? time?).
- `runs` — every recorded run of this case (append-only). If scores vary across
  identical runs, that's **variance**, not a deterministic bug — note it.
- `runId` + `artifacts` — the run to drill into and what it stored.

## Step 3 — Turn symptoms into hypotheses

Map what you see to the likely pipeline stage, then drill the matching evidence.

| Symptom in `case` | Likely cause | Drill with | atlas source |
| --- | --- | --- | --- |
| Factual criterion UNMET; few confirmed, many refuted | weak retrieval or over-strict verification | `claims --status refuted`, `sources` | `verify.ts`, `fetch-tool.ts` |
| `diagnostics` shows many `blockedOrThin` sources | fetch/extraction failing | `sources --blocked`, `trace --grep fetch` | `fetch-tool.ts`, `html-extract.ts` |
| Coverage/depth criterion UNMET; report thin | lead stopped early / pursued wrong angles | `transcript --role lead` | `research-loop.ts`, `recall.ts` |
| `finishReason` = budget/timeout | run starved before finishing | `transcript` summary (step count, `in=` tokens) | `config-resolution.ts`, `runtime.ts` |
| Judge `reason` contradicts the report | possible judge error | rubric cross-check (Step 4) | grading in `draco.ts` |
| A claim wrongly refuted | a verifier over-refused | `transcript --grep <claim text>` → role `verify:<id>` | `verify.ts` |

Evidence commands (all take a `<runId>` from Step 2):

```bash
npx tsx evals/explore/query.ts claims <runId> [--status refuted]   # quotes, sourceId, per-vote evidence
npx tsx evals/explore/query.ts sources <runId> [--blocked]          # fetched sources; --id <s> dumps a body
npx tsx evals/explore/query.ts citations <runId>                    # what the report cited; not-fetched/-confirmed
npx tsx evals/explore/query.ts trace <runId> [--grep RE]            # pipeline event timeline
npx tsx evals/explore/query.ts diagnostics <runId>                  # aggregate health counters
```

## Step 4 — Cross-check the report against the rubric yourself

Don't take the judge's word for it. Read the produced report and the rubric and
grade the failed criteria independently:

```bash
npx tsx evals/explore/query.ts report <runId>     # the produced markdown
npx tsx evals/explore/query.ts rubric <caseId>    # sections, criteria, weights
```

For each UNMET criterion decide which it is — the distinction drives a different
fix:

- **Content genuinely missing** → a research/coverage problem (retrieval, lead
  loop, or budget).
- **Content present but not credited** → the report buried it or the judge
  missed it (synthesis phrasing, or a judge/grader issue).
- **Content present but wrong** → a verification or source-quality problem.

Note any place you disagree with the stored verdict — that's a judge-reliability
finding in its own right.

## Step 5 — Drill the transcript only where a hypothesis needs it

The transcript is the heaviest artifact. **Always summarize first**, then slice:

```bash
npx tsx evals/explore/query.ts transcript <runId>                  # summary: steps per role + seq ranges (no dump)
npx tsx evals/explore/query.ts transcript <runId> --role lead      # the lead's reasoning + tool calls
npx tsx evals/explore/query.ts transcript <runId> --grep "<text>"  # steps mentioning a claim/query/url
npx tsx evals/explore/query.ts transcript <runId> --role verify:<claimId>   # one verifier's investigation
npx tsx evals/explore/query.ts transcript <runId> --seq 8-12 --messages     # byte-exact input for a step range
```

Roles you'll see: `recall.scope`, `recall.triage`, `lead`, `extract`, `cluster`,
`verify:<claimId>`, `synthesis.data`, `synthesis.prose`. By default a step shows
its thinking + tool calls (the "why"); add `--messages` for the exact bytes the
model saw (large — use on a narrow `--seq`/`--step`). Use this to answer
questions the aggregates can't: *why did the lead stop after N searches? why did
verifier `verify:7` refute a true claim? what did synthesis have to work with?*

## Step 6 — Synthesize: root causes and fixes

Produce, for the user:

1. **Per target case** — the failed criteria, the root cause (tied to a specific
   pipeline stage and the evidence you found), and whether it's deterministic or
   variance across the run history.
2. **Cross-case patterns** — a stage failing the same way across several cases is
   the highest-leverage fix.
3. **Concrete improvements** — map each root cause to the atlas source that owns
   it (`recall.ts`, `research-loop.ts`, `fetch-tool.ts`, `claims.ts`,
   `cluster.ts`, `verify.ts`, `synthesize.ts`, `config-resolution.ts`). Read the
   relevant file before proposing a change, and cite `file:line`.

## Boundaries

- **Read-only.** This skill diagnoses; it never runs the benchmark or edits code.
  If the user wants a fix applied, hand off the specific file/line and proposed
  change — don't apply it under this skill.
- **Progressive disclosure.** Never dump a full transcript or every source body
  to pull a conclusion. Start at `commit`/`case`, slice the transcript. If you
  truly need a lot, say what and why first.
- **Honor the run history.** Scores that move across identical runs are variance
  — say so rather than over-fitting a story to one run.
- **Ground every claim.** Quote the judge `reason`, the verifier evidence, the
  transcript line, or the `file:line` you're citing. Don't infer a cause the
  stored data doesn't support; if the data can't decide, say what's missing.
