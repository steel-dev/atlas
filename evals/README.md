# Atlas Evals

`eval:browsecomp` runs BrowseComp-style hard retrieval cases with reproducible
seeded sampling. The runner does not vendor benchmark data; pass a JSONL file
with public BrowseComp cases or an internal bespoke set.

The official OpenAI BrowseComp CSV can be used directly; encrypted `problem`
and `answer` fields are decrypted from each row's `canary` field:

```bash
npm run eval:browsecomp -- --cases https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv --sample 25 --seed pr-smoke-v1
```

Use the shortcut when running the official set:

```bash
npm run eval:browsecomp:official -- --sample 25 --seed pr-smoke-v1
```

Add `--judge` to grade final reports with an LLM judge, following the official
BrowseComp style of semantic answer equivalence:

```bash
npm run eval:browsecomp:official -- --sample 25 --seed pr-smoke-v1 --judge
```

The judge defaults to the run provider/model. Override it with
`--judge-provider`, `--judge-model`, `--judge-base-url`, and `--judge-timeout`.

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
- one `result` row per case, including a compact `trace` of research events
- `summary`: exact-answer accuracy and operational metrics

Primary score is exact-answer accuracy. Secondary metrics include latency,
tool calls, verified source count, and unverified citation count. When `--judge`
is enabled, `accuracy` uses judge correctness while `exactAccuracy` remains in
the summary for comparison.
