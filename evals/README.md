# Atlas Evals

`eval:browsecomp` runs hard retrieval cases with reproducible seeded sampling.
When the official OpenAI BrowseComp CSV is used, the manifest records
`suite: "browsecomp"`. Other JSONL/CSV inputs are recorded as
`suite: "browsecomp-style"`.

The official OpenAI BrowseComp CSV can be used directly; encrypted `problem`
and `answer` fields are decrypted from each row's `canary` field:

```bash
npm run eval:browsecomp -- --cases https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv --sample 25 --seed pr-smoke-v1
```

Use the shortcut when running the official set:

```bash
npm run eval:browsecomp:official -- --sample 25 --seed pr-smoke-v1
```

Add `--judge` to grade final reports with an LLM judge using the official
BrowseComp grader template:

```bash
npm run eval:browsecomp:official -- --sample 25 --seed pr-smoke-v1 --judge
```

The judge defaults to the run provider/model. Override it with
`--judge-provider`, `--judge-model`, and `--judge-timeout`.

## Run

```bash
npm run eval:browsecomp -- --cases evals/cases/browsecomp.jsonl --sample 25 --seed pr-smoke-v1
```

For a quick parser/sampling smoke test, use the tiny example file:

```bash
npm run eval:browsecomp -- --cases evals/cases/browsecomp.example.jsonl --sample 1 --seed demo --dry-run
```

Use `--dry-run` to inspect the selected IDs without calling model or Steel APIs:

```bash
npm run eval:browsecomp -- --cases evals/cases/browsecomp.jsonl --sample 25 --seed pr-smoke-v1 --dry-run
```

The same seed and case file always produce the same subset. Sampling ranks cases
by `sha256(seed + case.id)`, then takes the first `N` cases.

Each case has a default 300 second timeout. Override it with `--timeout` when
running larger launch batches. Progress events are written to stderr while each
case runs.

## Case Format

Each JSONL/CSV row may use common BrowseComp/simple-evals field names:

```json
{"id":"example-1","question":"What date did Example Corp announce X?","answer":"2025-01-15"}
```

Supported question fields: `question`, `problem`, `query`, `prompt`, `input`.
Supported answer fields: `answer`, `answers`, `correct_answer`, `target`,
`ideal`, `reference_answer`.

If a row contains `canary`, the runner treats `problem` and `answer` as encrypted
OpenAI BrowseComp fields and decrypts them before sampling/running.

## Output

Results are written to `eval-runs/browsecomp-<timestamp>.jsonl` unless `--out`
is provided. The file contains:

- `manifest`: seed, sample size, selected case IDs
- one `result` row per case, including `structured.final_answer` when available
  and a compact `trace` of research events
- `summary`: exact-answer accuracy and operational metrics

Primary exact scoring uses `structured.final_answer`, falling back to the
Markdown `Final answer:` line. Secondary metrics include latency, tool calls,
cited source count, and not-fetched citation count. When `--judge` is enabled,
`accuracy` uses judge correctness while `exactAccuracy` remains in the summary
for comparison.

---

# DRACO

`eval:draco` runs Perplexity's [DRACO](https://arxiv.org/abs/2602.11685) benchmark
(*Deep Research Accuracy, Completeness, and Objectivity*) — 100 tasks across 10
domains, each graded against an expert rubric instead of a single answer. Unlike
BrowseComp, the full Markdown report is what gets scored.

Cases come from the [`perplexity-ai/draco`](https://huggingface.co/datasets/perplexity-ai/draco)
dataset (the default `--cases` URL), pinned to an immutable dataset revision so
scores stay reproducible as `main` moves; the manifest records `casesRevision`.
Each row is `{ id, domain, problem, answer }`
where `answer` is a JSON-encoded rubric: `sections[].criteria[]` with
`{ id, weight, requirement }`. Four sections — `factual-accuracy` (~50% of weight),
`breadth-and-depth-of-analysis`, `presentation-quality`, `citation-quality` —
average ~40 criteria per task.

## Run

```bash
npm run eval:draco -- --sample 10 --seed draco-v1
```

`--sample N` is **domain-stratified** by default: it spreads N tasks evenly across
the 10 domains (so `--sample 10` is one per domain). Pass `--stratify none` for a
plain seeded global sample. The same seed always produces the same subset.

Inspect the selection without calling any API:

```bash
npm run eval:draco -- --dry-run --sample 10 --seed draco-v1
```

Other useful flags: `--domain "Finance,Law"`, `--case-id <uuid>`, `--concurrency N`
(parallel tasks), `--timeout` (per-task research seconds, default 900; `0` = unlimited,
matching DRACO's no-limit protocol), `--retries N` (retry a task's research run on
transient errors like rate limits, default 1), `--token-limit`,
`--provider`/`--model` (research model). Run with `--help` for the full list.

## Grading (LLM-as-judge)

Grading replicates the open-source protocol DRACO uses
([`The-LLM-Data-Company/rubric`](https://github.com/The-LLM-Data-Company/rubric)):
the judge returns a binary **MET/UNMET** verdict per criterion, and scores aggregate
by weight.

- **Judge model** defaults to **`gemini-3.1-pro-preview`** — the paper's primary judge
  was `gemini-3-pro-preview`, now retired on the Google API, so this is its current
  Gemini-3-line successor. Needs `GOOGLE_GENERATIVE_AI_API_KEY`. The paper reports
  rankings are stable across the Gemini-3-Pro / GPT-5.2 / Sonnet-4.5 judges, so without
  a Google key you can fall back to `--judge-provider anthropic --judge-model
  claude-sonnet-4-5` (or `--judge-provider openai`). The manifest records the judge
  model so results are self-describing.
- **Grader strategy**: `--grader per-criterion` (default) scores each criterion in an
  isolated call (the paper grades "independently for each criterion"); `--grader
  one-shot` scores all criteria in a single call — cheaper, good for smoke tests.
- **Scores** (per the paper / repo): `normalized = clamp(Σ MET·weight / Σ positive
  weight, 0, 1)`, and `pass rate = fraction of criteria where positive→MET or
  negative→UNMET`. Both are reported overall, per domain, and per section.
- **Reproducibility / coverage**: judge calls are pinned to `temperature 0`.
  Criteria the judge fails to grade (timeout, rate-limit, or a missing index under
  `one-shot`) are flagged with `judgeError` and **excluded from the score
  denominator** rather than silently counted as UNMET; the run reports `grading
  coverage` (graded / total criteria). A task whose criteria *all* error is left
  unscored — kept in operational metrics but dropped from the scored set — instead
  of being recorded as a misleading 0%.

Tune the judge with `--judge-provider`, `--judge-model`, `--judge-timeout`
(per-criterion seconds), and `--judge-concurrency` (parallel judge calls per task;
per-criterion grading issues ~40 per task).

## Re-grading saved reports (`--regrade`)

Research is the expensive, slow part; judging is cheap. `--regrade` decouples them —
it re-judges the saved reports in a prior results JSONL **without re-running any
research**, reusing each task's stored `markdown` + rubric:

```bash
npm run eval:draco -- --regrade eval-runs/draco-<timestamp>.jsonl --grader per-criterion
```

Use it to iterate on the grader/judge for the cost of judge calls only — e.g. upgrade
a cheap `one-shot` run to the faithful `per-criterion` grader, swap judge models, or
re-judge a task that failed its judge. Operational metrics (latency, tokens, fetch
health) carry over from the original run; tasks that errored during research (no saved
report) pass through untouched. Output goes to `eval-runs/draco-regrade-<timestamp>.jsonl`
unless `--out` is given, and the manifest records `mode: "regrade"` + `regradedFrom`.

## Output

Results are written to `eval-runs/draco-<timestamp>.jsonl` unless `--out` is given:

- `manifest`: seed, sample, stratification, grader, research + judge model, and the
  selected `{id, domain, criteria}`.
- one `result` per task: `domain`, `problem`, `markdown`, `score`
  (`normalizedScore`, `passRate`, `rawScore`, per-section `sections[]`), the
  per-criterion `report[]` (`verdict` + `reason`), plus `trace`, `diagnostics`, and
  `metrics` (latency, tokens, cited sources).
- `summary`: mean normalized score, mean pass rate, per-domain and per-section
  breakdowns, `coverage`/`gradedCriteria`/`totalCriteria`/`ungraded` (judge grading
  coverage), efficiency metrics matching the paper's Table 10 (`averageLatencyMs`,
  `averageInputTokens`, `averageOutputTokens`), plus median latency, tool calls, fetch
  health, and choke diagnostics.

## Environment

The eval reads keys from the environment (`STEEL_API_KEY`, the research provider key,
and the judge key). If they live in `.env`, load them with Node's `--env-file`:

```bash
node --env-file=.env --import tsx evals/draco.ts --sample 10 --seed draco-v1
```
