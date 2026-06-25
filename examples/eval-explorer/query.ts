import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { captureCommit } from "./git.js";
import { type RunUsage, runCost } from "./pricing.js";
import { Store } from "./store.js";

const USAGE = `draco query — read-only drill-down over benchmark runs

Usage:
  npx tsx evals/explore/query.ts <command> [args] [--db PATH]

Overview (cheap, start here):
  commits                         List commits with run counts + avg score
  commit [<sha>] [--baseline <s>] [--cost]
                                  Per-case grid for a commit, Δ vs a baseline;
                                  --cost adds per-case + total USD (defaults:
                                  sha=HEAD, baseline=previous commit)

Per-case (one case, still compact):
  case <sha> <caseId>             Rubric + per-criterion MET/UNMET + judge
                                  reason + score + claim stats + run list
  verdicts <runId>                One run's grading: 4 axis scores + UNMET
                                  criteria (judge reason + k-vote split + weight)
  rubric <caseId>                 The rubric (sections, criteria, weights)

Evidence (one run — get run_id from \`case\`/\`runs\`):
  report <runId>                  The produced markdown report
  claims <runId> [--status S]     Claims w/ quote, sourceId, votes (S=confirmed|refuted|unverified)
  sources <runId> [--id S] [--blocked]   Fetched sources (--id dumps full body)
  citations <runId>               Citation map + not-fetched / not-confirmed
  trace <runId> [--grep RE]       Lightweight pipeline event timeline
  diagnostics <runId>             Aggregate health counters
  cost <runId>                    Token usage + estimated USD (research + judge)
  blobs <runId>                   Which artifacts this run stored + sizes

Transcript (byte-exact model steps — sliced):
  transcript <runId>              Summary: steps per role + seq ranges (no dump)
  transcript <runId> --role R | --seq A-B | --step N | --grep RE | --head N
                                  Show matching steps' reasoning + tool calls
                                  add --messages for the byte-exact input thread

Trace (timing/cost spans + bottleneck digest):
  digest <runId>                  Auto bottleneck digest: critical path, phase
                                  breakdown, wait-vs-compute, anomalies + code sites
  spans <runId> [--kind K] [--grep RE]   Raw timing spans (K=model|tool|io|agent)

History:
  runs <sha> [<caseId>]           Every run (append-only), newest first

Analysis (agent-first):
  diff <shaA> <shaB>              Per-case score Δ + aggregate tool-discipline Δ
                                  (search/fetch/search_sources/read_source/run_code/note) between two commits
  audit <runId>                   Tool histogram + search redundancy (near-dup query pairs)
                                  + phase budget + critical-path / wait-vs-compute digest
  systems [<sha>]                 Per-system mean±CI(95%) over cases + 4 axes (FA/BD/PQ/CQ)
                                  + paired per-case deltas between systems
  quality [<sha>]                 Per-run research health: sources, report size, finish, cost, latency

Options:
  --db PATH    SQLite path (default: eval-runs/draco-explore.db)
  --json       Force JSON output (default for structured commands)
`;

function fail(message: string): never {
  process.stderr.write(`draco-query: ${message}\n`);
  process.exit(1);
}

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function raw(text: string): void {
  process.stdout.write(`${text}\n`);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

interface Flags {
  db: string;
  baseline?: string;
  status?: string;
  id?: string;
  blocked: boolean;
  role?: string;
  seq?: string;
  step?: string;
  grep?: string;
  head?: string;
  kind?: string;
  messages: boolean;
  json: boolean;
  cost: boolean;
}

function need(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) fail(`missing <${name}>`);
  return value;
}

function resolveCommit(sha: string | undefined): string {
  return sha ?? captureCommit().sha;
}

function cmdCommits(store: Store): void {
  out(store.commits());
}

function cmdCommit(store: Store, positionals: string[], flags: Flags): void {
  const sha = resolveCommit(positionals[1]);
  const baseline =
    flags.baseline ??
    store.commits().find((c) => c.commitSha !== sha)?.commitSha;
  const baseBy = new Map(
    (baseline ? store.grid(baseline) : []).map((r) => [r.caseId, r.normalized]),
  );
  const grid = store.grid(sha);
  const scored = grid.filter((r) => r.status === "scored");
  const cases = grid.map((r) => {
    const base = baseBy.get(r.caseId);
    const delta =
      r.normalized !== null && base !== null && base !== undefined
        ? Number((r.normalized - base).toFixed(4))
        : null;
    return {
      caseId: r.caseId,
      domain: r.domain,
      status: r.status,
      normalized: r.normalized,
      delta,
      passRate: r.passRate,
      failedCriteria:
        r.gradedCriteria !== null && r.passRate !== null
          ? Math.round(r.gradedCriteria * (1 - r.passRate))
          : null,
      judgeErrors: r.judgeErrors,
      error: r.error,
      runId: r.runId,
    };
  });
  const costed = flags.cost
    ? cases.map((c) => ({
        ...c,
        estCostUsd: c.runId
          ? runCost(
              parseJson(
                store.getBlob(c.runId, "usage") ?? "null",
              ) as RunUsage | null,
            ).totalUsd
          : null,
      }))
    : cases;
  const totalCostUsd = flags.cost
    ? Number(
        costed
          .reduce(
            (s, c) =>
              s + ((c as { estCostUsd?: number | null }).estCostUsd ?? 0),
            0,
          )
          .toFixed(4),
      )
    : undefined;
  out({
    commit: sha,
    baseline: baseline ?? null,
    avgNormalized:
      scored.length > 0
        ? Number(
            (
              scored.reduce((s, r) => s + (r.normalized ?? 0), 0) /
              scored.length
            ).toFixed(4),
          )
        : null,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    scored: scored.length,
    errors: grid.filter((r) => r.status === "error").length,
    unrun: grid.filter((r) => r.status === null).length,
    regressions: cases
      .filter((c) => c.delta !== null && c.delta < 0)
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
      .map((c) => `${c.caseId} (${c.delta})`),
    cases: costed,
  });
}

function cmdCase(store: Store, positionals: string[]): void {
  const sha = need(positionals, 1, "sha");
  const caseId = need(positionals, 2, "caseId");
  const detail = store.detail(sha, caseId);
  if (!detail) {
    const rubric = store.caseRubric(caseId);
    if (!rubric) fail(`case not found: ${caseId}`);
    out({ commit: sha, caseId, status: "unrun", rubric: shapeRubric(rubric) });
    return;
  }
  const runId = detail.run_id as string;
  const report = (parseJson(detail.report_json) as Criterion[] | null) ?? [];
  const claims = parseJson(store.getBlob(runId, "claims") ?? "null") as {
    confirmed?: unknown[];
    refuted?: unknown[];
    unverified?: unknown[];
  } | null;
  const criteria = report.map((c) => ({
    id: c.id,
    section: c.sectionId,
    weight: c.weight,
    verdict: c.verdict,
    requirement: c.requirement,
    reason: c.reason,
    ...(c.metVotes !== undefined && c.runs !== undefined
      ? { metVotes: `${c.metVotes}/${c.runs}` }
      : {}),
    ...(c.judgeError ? { judgeError: c.judgeError } : {}),
  }));
  out({
    commit: sha,
    caseId,
    runId,
    domain: detail.case_domain ?? detail.domain,
    problem: detail.case_problem,
    status: detail.status,
    score: parseJson(detail.score_json),
    finishReason: detail.finish_reason,
    error: detail.error,
    latencyMs: detail.latency_ms,
    failedCriteria: criteria.filter((c) => c.verdict === "UNMET"),
    criteria,
    claimStats: claims
      ? {
          confirmed: claims.confirmed?.length ?? 0,
          refuted: claims.refuted?.length ?? 0,
          unverified: claims.unverified?.length ?? 0,
        }
      : null,
    diagnostics: parseJson(detail.diagnostics_json),
    cost: runCost(
      parseJson(store.getBlob(runId, "usage") ?? "null") as RunUsage | null,
    ),
    runs: store.listRuns(sha, caseId).map((r) => ({
      runId: r.runId,
      normalized: r.normalized,
      createdAt: r.createdAt,
    })),
    artifacts: store.blobInfo(runId),
  });
}

interface Criterion {
  id: string;
  sectionId: string;
  requirement: string;
  weight: number;
  verdict: string;
  reason: string;
  judgeError?: string;
  metVotes?: number;
  runs?: number;
}

function cmdVerdicts(store: Store, positionals: string[]): void {
  const runId = need(positionals, 1, "runId");
  const report =
    (parseJson(blobOrFail(store, runId, "report")) as Criterion[] | null) ?? [];
  const score = parseJson(store.getBlob(runId, "score") ?? "null") as {
    normalizedScore?: number;
    sections?: Array<{
      id: string;
      normalizedScore: number;
      passRate: number;
      criteria: number;
    }>;
  } | null;
  const pct = (n: number) => Math.round(n * 1000) / 10;
  const sections = (score?.sections ?? []).map((s) => ({
    id: s.id,
    score: pct(s.normalizedScore),
    passRate: pct(s.passRate),
    criteria: s.criteria,
  }));
  const unmet = report
    .filter((c) => c.verdict === "UNMET")
    .sort((a, b) => b.weight - a.weight)
    .map((c) => ({
      section: c.sectionId,
      id: c.id,
      weight: c.weight,
      ...(c.metVotes !== undefined && c.runs !== undefined
        ? { metVotes: `${c.metVotes}/${c.runs}` }
        : {}),
      requirement: c.requirement,
      reason: c.reason,
    }));
  const unmetBySection: Record<string, { unmet: number; weightLost: number }> =
    {};
  for (const c of unmet) {
    const b = (unmetBySection[c.section] ??= { unmet: 0, weightLost: 0 });
    b.unmet++;
    b.weightLost += c.weight;
  }
  out({
    runId,
    overall:
      score?.normalizedScore !== undefined ? pct(score.normalizedScore) : null,
    sections,
    unmetBySection,
    unmetCount: unmet.length,
    metCount: report.length - unmet.length,
    unmet,
  });
}

function shapeRubric(row: Record<string, unknown>): unknown {
  return {
    caseId: row.case_id,
    domain: row.domain,
    problem: row.problem,
    sections: parseJson(row.sections_json as string),
    criteria: parseJson(row.criteria_json as string),
  };
}

function cmdRubric(store: Store, positionals: string[]): void {
  const caseId = need(positionals, 1, "caseId");
  const rubric = store.caseRubric(caseId);
  if (!rubric) fail(`case not found: ${caseId}`);
  out(shapeRubric(rubric));
}

function blobOrFail(store: Store, runId: string, kind: string): string {
  const value = store.getBlob(runId, kind);
  if (value === undefined) {
    fail(
      `no '${kind}' for run ${runId} (available: ${
        store
          .blobInfo(runId)
          .map((b) => b.kind)
          .join(", ") || "none"
      })`,
    );
  }
  return value;
}

function cmdReport(store: Store, positionals: string[]): void {
  raw(blobOrFail(store, need(positionals, 1, "runId"), "markdown"));
}

function cmdClaims(store: Store, positionals: string[], flags: Flags): void {
  const runId = need(positionals, 1, "runId");
  const claims = parseJson(blobOrFail(store, runId, "claims")) as Record<
    string,
    unknown[]
  >;
  if (flags.status) {
    out(claims[flags.status] ?? []);
    return;
  }
  out(claims);
}

function cmdSources(store: Store, positionals: string[], flags: Flags): void {
  const runId = need(positionals, 1, "runId");
  const sources = (parseJson(blobOrFail(store, runId, "sources")) ??
    []) as Array<Record<string, unknown>>;
  if (flags.id) {
    const doc = sources.find(
      (s) => s.sourceId === flags.id || s.url === flags.id,
    );
    if (!doc) fail(`source not found: ${flags.id}`);
    raw(String(doc.markdown ?? ""));
    return;
  }
  const list = sources.map((s) => ({
    sourceId: s.sourceId,
    url: s.url,
    title: s.title,
    markdownChars:
      typeof s.markdown === "string" ? s.markdown.length : undefined,
  }));
  out(flags.blocked ? list.filter((s) => (s.markdownChars ?? 0) < 500) : list);
}

function cmdCitations(store: Store, positionals: string[]): void {
  out(parseJson(blobOrFail(store, need(positionals, 1, "runId"), "citations")));
}

function cmdTrace(store: Store, positionals: string[], flags: Flags): void {
  const runId = need(positionals, 1, "runId");
  const trace = (parseJson(blobOrFail(store, runId, "trace")) ?? []) as Array<
    Record<string, unknown>
  >;
  if (!flags.grep) {
    out(trace);
    return;
  }
  const re = new RegExp(flags.grep, "i");
  out(trace.filter((e) => re.test(JSON.stringify(e))));
}

function cmdDiagnostics(store: Store, positionals: string[]): void {
  out(
    parseJson(blobOrFail(store, need(positionals, 1, "runId"), "diagnostics")),
  );
}

function cmdCost(store: Store, positionals: string[]): void {
  const runId = need(positionals, 1, "runId");
  const usage = parseJson(blobOrFail(store, runId, "usage")) as RunUsage | null;
  out({ runId, ...runCost(usage), raw: usage });
}

function cmdBlobs(store: Store, positionals: string[]): void {
  out(store.blobInfo(need(positionals, 1, "runId")));
}

function cmdRuns(store: Store, positionals: string[]): void {
  const sha = need(positionals, 1, "sha");
  out(store.listRuns(sha, positionals[2]));
}

function cmdDigest(store: Store, positionals: string[]): void {
  out(parseJson(blobOrFail(store, need(positionals, 1, "runId"), "digest")));
}

function cmdSpans(store: Store, positionals: string[], flags: Flags): void {
  const runId = need(positionals, 1, "runId");
  let spans = (parseJson(blobOrFail(store, runId, "spans")) ?? []) as Array<
    Record<string, unknown>
  >;
  if (flags.kind) spans = spans.filter((s) => s.kind === flags.kind);
  if (flags.grep) {
    const re = new RegExp(flags.grep, "i");
    spans = spans.filter((s) => re.test(JSON.stringify(s)));
  }
  out(spans);
}

interface TranscriptStep {
  seq: number;
  atMs: number;
  role: string;
  adapter: string;
  durationMs: number;
  system: string;
  messages: unknown[];
  toolNames?: string[];
  maxTokens: number;
  outputSchema?: string;
  output: Array<Record<string, unknown>>;
  inputTokens?: number;
  error?: string;
}

function renderBlock(block: Record<string, unknown>): string {
  switch (block.type) {
    case "thinking":
      return `  [thinking] ${block.thinking}`;
    case "redacted_thinking":
      return `  [thinking redacted]`;
    case "text":
      return `  [text] ${block.text}`;
    case "tool_call":
      return `  [tool_call ${block.name}] ${JSON.stringify(block.input)}`;
    default:
      return `  [${String(block.type)}]`;
  }
}

function renderStep(step: TranscriptStep, includeMessages: boolean): string {
  const head =
    `#${step.seq} [${step.role}] ${step.adapter} +${step.atMs}ms ` +
    `dur=${step.durationMs}ms` +
    (step.inputTokens !== undefined ? ` in=${step.inputTokens}tok` : "") +
    (step.outputSchema ? ` schema=${step.outputSchema}` : "") +
    (step.toolNames ? ` tools=[${step.toolNames.join(",")}]` : "");
  const lines = [head, ...step.output.map(renderBlock)];
  if (step.error) lines.push(`  [error] ${step.error}`);
  if (includeMessages) {
    lines.push("  [messages]");
    lines.push(JSON.stringify(step.messages, null, 2));
  }
  return lines.join("\n");
}

function cmdTranscript(
  store: Store,
  positionals: string[],
  flags: Flags,
): void {
  const runId = need(positionals, 1, "runId");
  const steps = (parseJson(blobOrFail(store, runId, "transcript")) ??
    []) as TranscriptStep[];
  const bytes =
    store.blobInfo(runId).find((b) => b.kind === "transcript")?.bytes ?? 0;
  const selecting =
    flags.role || flags.seq || flags.step || flags.grep || flags.head;

  if (!selecting) {
    const byRole = new Map<string, number[]>();
    for (const s of steps) {
      const arr = byRole.get(s.role) ?? [];
      arr.push(s.seq);
      byRole.set(s.role, arr);
    }
    out({
      runId,
      totalSteps: steps.length,
      uncompressedBytes: bytes,
      roles: [...byRole.entries()].map(([role, seqs]) => ({
        role,
        steps: seqs.length,
        seqRange: [Math.min(...seqs), Math.max(...seqs)],
      })),
      hint: "select steps with --role R | --seq A-B | --step N | --grep RE | --head N; add --messages for the byte-exact input thread",
    });
    return;
  }

  let selected = steps;
  if (flags.role) selected = selected.filter((s) => s.role === flags.role);
  if (flags.step !== undefined) {
    const n = Number(flags.step);
    selected = selected.filter((s) => s.seq === n);
  }
  if (flags.seq) {
    const [a, b] = flags.seq.split("-").map(Number);
    const lo = a;
    const hi = Number.isFinite(b) ? b : a;
    selected = selected.filter((s) => s.seq >= lo && s.seq <= hi);
  }
  if (flags.grep) {
    const re = new RegExp(flags.grep, "i");
    selected = selected.filter(
      (s) =>
        re.test(JSON.stringify(s.output)) ||
        re.test(JSON.stringify(s.messages)),
    );
  }
  if (flags.head) selected = selected.slice(0, Number(flags.head));

  if (selected.length === 0) {
    raw("(no steps matched)");
    return;
  }
  raw(selected.map((s) => renderStep(s, flags.messages)).join("\n\n"));
}

function transcriptSteps(store: Store, runId: string): TranscriptStep[] {
  const blob = store.getBlob(runId, "transcript");
  return blob ? ((parseJson(blob) as TranscriptStep[]) ?? []) : [];
}

function toolHistogram(steps: TranscriptStep[]): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const step of steps) {
    for (const block of step.output ?? []) {
      if (block.type === "tool_call") {
        const name = String(block.name ?? "?");
        hist[name] = (hist[name] ?? 0) + 1;
      }
    }
  }
  return hist;
}

function searchQueries(steps: TranscriptStep[]): string[] {
  const queries: string[] = [];
  for (const step of steps) {
    for (const block of step.output ?? []) {
      if (block.type !== "tool_call" || block.name !== "search") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const list = input.queries;
      if (Array.isArray(list)) {
        for (const q of list) if (typeof q === "string") queries.push(q);
      }
      if (typeof input.query === "string") queries.push(input.query);
    }
  }
  return queries;
}

const QUERY_STOPWORDS = /\b(or|and|the|of|in|on|for|to|a|an|site)\b/gi;

function queryTokens(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .replace(/["']/g, " ")
      .replace(QUERY_STOPWORDS, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function nearDupPairs(queries: string[], threshold = 0.5): number {
  const sets = queries.map(queryTokens);
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (jaccard(sets[i]!, sets[j]!) >= threshold) pairs++;
    }
  }
  return pairs;
}

function computeFetchYield(
  store: Store,
  runId: string,
): Record<string, unknown> {
  const sources = (parseJson(store.getBlob(runId, "sources") ?? "[]") ??
    []) as Array<{ id?: string; url?: string; via?: string }>;
  const cit = parseJson(store.getBlob(runId, "citations") ?? "null") as {
    citations?: Array<{ sourceId?: string }>;
  } | null;
  const fetched = sources
    .map((s) => s.id)
    .filter((x): x is string => Boolean(x));
  const cited = new Set(
    (cit?.citations ?? [])
      .map((c) => c.sourceId)
      .filter((x): x is string => Boolean(x)),
  );
  const uncitedUrls = sources
    .filter((s) => s.id && !cited.has(s.id))
    .map((s) => s.url);
  const byVia: Record<string, number> = {};
  for (const s of sources) {
    const via = s.via ?? "unknown";
    byVia[via] = (byVia[via] ?? 0) + 1;
  }
  return {
    fetched: fetched.length,
    cited: cited.size,
    uncited: uncitedUrls.length,
    yield: fetched.length
      ? Number((cited.size / fetched.length).toFixed(2))
      : null,
    byVia,
    uncitedUrls,
  };
}

function cmdAudit(store: Store, positionals: string[]): void {
  const runId = need(positionals, 1, "runId");
  const steps = transcriptSteps(store, runId);
  const digest = parseJson(store.getBlob(runId, "digest") ?? "null") as Record<
    string,
    any
  > | null;
  const hist = toolHistogram(steps);
  const queries = searchQueries(steps);
  const fetchCalls = hist.fetch ?? 0;
  const phases = digest?.phaseBreakdown ?? {};
  out({
    runId,
    toolCalls: hist,
    search: {
      queries: queries.length,
      uniqueExact: new Set(queries.map((q) => q.toLowerCase().trim())).size,
      nearDupPairs: nearDupPairs(queries),
      queriesPerFetch:
        fetchCalls > 0
          ? Number((queries.length / fetchCalls).toFixed(1))
          : null,
    },
    fetchYield: computeFetchYield(store, runId),
    phases: Object.fromEntries(
      Object.entries(phases).map(([k, v]) => [
        k,
        {
          wallMs: (v as any).wallMs,
          costUSD: (v as any).costUSD,
          tokens: (v as any).tokens,
          spanCount: (v as any).spanCount,
        },
      ]),
    ),
    critical: digest
      ? {
          wallMs: digest.wallMs,
          criticalPathPct: digest.wallMs
            ? Math.round((digest.criticalPathMs / digest.wallMs) * 100)
            : null,
          waitVsCompute: digest.waitVsCompute,
          idleMs: digest.idleMs,
          peakModelInFlight: digest.concurrency?.peakModelInFlight,
        }
      : null,
    anomalies: ((digest?.anomalies ?? []) as any[]).map(
      (a) => `${a.kind}@${a.site ?? "?"}: ${a.detail}`,
    ),
  });
}

function commitToolTotals(
  store: Store,
  commit: string,
): { totals: Record<string, number>; runs: number } {
  const totals: Record<string, number> = {};
  let runs = 0;
  for (const row of store.grid(commit)) {
    if (!row.runId) continue;
    runs++;
    const hist = toolHistogram(transcriptSteps(store, row.runId));
    for (const [k, v] of Object.entries(hist)) totals[k] = (totals[k] ?? 0) + v;
  }
  return { totals, runs };
}

function cmdDiff(store: Store, positionals: string[]): void {
  const shaA = need(positionals, 1, "shaA");
  const shaB = need(positionals, 2, "shaB");
  const gridB = new Map(store.grid(shaB).map((r) => [r.caseId, r]));
  const perCase = store
    .grid(shaA)
    .filter((a) => gridB.has(a.caseId))
    .map((a) => {
      const b = gridB.get(a.caseId)!;
      const delta =
        a.normalized !== null && b.normalized !== null
          ? Number((a.normalized - b.normalized).toFixed(4))
          : null;
      return {
        caseId: a.caseId,
        domain: a.domain,
        a: a.normalized,
        b: b.normalized,
        delta,
      };
    });
  const scored = perCase.filter((c) => c.delta !== null);
  const totalsA = commitToolTotals(store, shaA);
  const totalsB = commitToolTotals(store, shaB);
  const toolKeys = [
    ...new Set([
      ...Object.keys(totalsA.totals),
      ...Object.keys(totalsB.totals),
    ]),
  ].sort();
  const toolDelta = Object.fromEntries(
    toolKeys.map((k) => [
      k,
      {
        a: totalsA.totals[k] ?? 0,
        b: totalsB.totals[k] ?? 0,
        delta: (totalsA.totals[k] ?? 0) - (totalsB.totals[k] ?? 0),
      },
    ]),
  );
  out({
    a: shaA.slice(0, 10),
    b: shaB.slice(0, 10),
    sharedCases: perCase.length,
    avgScoreDelta: scored.length
      ? Number(
          (
            scored.reduce((s, c) => s + (c.delta ?? 0), 0) / scored.length
          ).toFixed(4),
        )
      : null,
    regressions: scored
      .filter((c) => (c.delta ?? 0) < 0)
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
      .map((c) => `${c.caseId} (${c.delta})`),
    improvements: scored
      .filter((c) => (c.delta ?? 0) > 0)
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
      .map((c) => `${c.caseId} (+${c.delta})`),
    toolDiscipline: {
      runsA: totalsA.runs,
      runsB: totalsB.runs,
      delta: toolDelta,
    },
    perCase,
    ...(scored.length < 3
      ? { noisy: "few shared scored cases — deltas are noisy" }
      : {}),
  });
}

const SECTION_LABELS: Record<string, string> = {
  "factual-accuracy": "FA",
  "breadth-and-depth-of-analysis": "BD",
  "presentation-quality": "PQ",
  "citation-quality": "CQ",
};

const T95: Record<number, number> = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
};

function t95(df: number): number {
  if (df <= 0) return 0;
  if (df <= 20) return T95[df];
  if (df <= 29) return 2.045;
  return 1.96;
}

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdSample(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function round(x: number, d = 4): number {
  return Number(x.toFixed(d));
}

function systemCost(store: Store, runId: string): number | null {
  const diag = parseJson(store.getBlob(runId, "diagnostics")) as {
    stats?: { costUSD?: number };
    exa?: { costDollars?: { total?: number } | number };
  } | null;
  if (typeof diag?.stats?.costUSD === "number" && diag.stats.costUSD > 0)
    return diag.stats.costUSD;
  const c = diag?.exa?.costDollars;
  const exaTotal =
    c && typeof c === "object"
      ? c.total
      : typeof c === "number"
        ? c
        : undefined;
  if (typeof exaTotal === "number" && exaTotal > 0) return exaTotal;
  const usage = parseJson(store.getBlob(runId, "usage")) as RunUsage | null;
  const u = runCost(usage).totalUsd;
  return u !== null && u > 0 ? u : null;
}

function pairedDelta(
  a: Map<string, number>,
  b: Map<string, number>,
): {
  n: number;
  meanDelta: number;
  ci95: number;
  lo: number;
  hi: number;
  aWins: number;
  significant: boolean;
} | null {
  const deltas: number[] = [];
  for (const [cid, va] of a) {
    const vb = b.get(cid);
    if (vb !== undefined) deltas.push(va - vb);
  }
  const n = deltas.length;
  if (n === 0) return null;
  const m = meanOf(deltas);
  const sd = stdSample(deltas);
  const ci = n >= 2 ? t95(n - 1) * (sd / Math.sqrt(n)) : 0;
  return {
    n,
    meanDelta: round(m),
    ci95: round(ci),
    lo: round(m - ci),
    hi: round(m + ci),
    aWins: deltas.filter((d) => d > 0).length,
    significant: m - ci > 0 || m + ci < 0,
  };
}

function cmdSystems(store: Store, positionals: string[]): void {
  const sha = resolveCommit(positionals[1]);
  const runs = store.listRuns(sha);
  const byModel = new Map<string, Map<string, (typeof runs)[number]>>();
  for (const r of runs) {
    const model = r.researchModel ?? "unknown";
    let perCase = byModel.get(model);
    if (!perCase) {
      perCase = new Map();
      byModel.set(model, perCase);
    }
    if (!perCase.has(r.caseId)) perCase.set(r.caseId, r);
  }
  const systems = [...byModel.entries()].map(([model, perCase]) => {
    const cases = [...perCase.values()];
    const scoredRuns = cases.filter(
      (r) => r.status === "scored" && r.normalized !== null,
    );
    const norms = scoredRuns.map((r) => r.normalized as number);
    const axisVals: Record<string, number[]> = {};
    const costs: number[] = [];
    for (const r of scoredRuns) {
      const score = parseJson(store.getBlob(r.runId, "score")) as {
        sections?: Array<{ id: string; normalizedScore: number }>;
      } | null;
      for (const sec of score?.sections ?? []) {
        (axisVals[sec.id] ??= []).push(sec.normalizedScore);
      }
      const c = systemCost(store, r.runId);
      if (c !== null) costs.push(c);
    }
    const n = norms.length;
    const m = n ? meanOf(norms) : null;
    const sd = n >= 2 ? stdSample(norms) : n === 1 ? 0 : null;
    const sem = sd !== null && n > 0 ? sd / Math.sqrt(n) : null;
    const ci = sem !== null && n >= 2 ? t95(n - 1) * sem : n === 1 ? 0 : null;
    const axes: Record<string, number | null> = {};
    for (const id of Object.keys(SECTION_LABELS)) {
      const vals = axisVals[id];
      axes[SECTION_LABELS[id]] = vals?.length ? round(meanOf(vals)) : null;
    }
    return {
      system: model,
      n: cases.length,
      scored: n,
      errors: cases.filter((r) => r.status === "error").length,
      meanNormalized: m !== null ? round(m) : null,
      sd: sd !== null ? round(sd) : null,
      sem: sem !== null ? round(sem) : null,
      ci95: ci !== null ? round(ci) : null,
      lo: m !== null && ci !== null ? round(m - ci) : null,
      hi: m !== null && ci !== null ? round(m + ci) : null,
      axes,
      meanCostUsd: costs.length ? round(meanOf(costs)) : null,
    };
  });
  systems.sort((a, b) => (b.meanNormalized ?? -1) - (a.meanNormalized ?? -1));
  const caseScores = new Map<string, Map<string, number>>();
  for (const [model, perCase] of byModel) {
    const scored = new Map<string, number>();
    for (const [cid, r] of perCase)
      if (r.status === "scored" && r.normalized !== null)
        scored.set(cid, r.normalized);
    caseScores.set(model, scored);
  }
  const pairs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      const a = systems[i].system;
      const b = systems[j].system;
      const pd = pairedDelta(
        caseScores.get(a) ?? new Map<string, number>(),
        caseScores.get(b) ?? new Map<string, number>(),
      );
      if (pd) pairs.push({ a, b, ...pd });
    }
  }
  out({ commit: sha, systems, pairs });
}

function cmdQuality(store: Store, positionals: string[]): void {
  const sha = resolveCommit(positionals[1]);
  const runs = store.listRuns(sha);
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const r of runs) {
    const key = `${r.caseId}|${r.researchModel ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const md = store.getBlob(r.runId, "markdown") ?? "";
    const srcBlob = store.getBlob(r.runId, "sources");
    const sources = srcBlob
      ? ((parseJson(srcBlob) as unknown[]) ?? []).length
      : 0;
    const diag = parseJson(store.getBlob(r.runId, "diagnostics")) as {
      stats?: { budgetExhausted?: boolean };
    } | null;
    const scalars = store.runScalars(r.runId) as
      | { latency_ms?: number }
      | undefined;
    rows.push({
      system: r.researchModel,
      domain: r.domain,
      caseId: r.caseId,
      status: r.status,
      sources,
      reportChars: md.length,
      finish:
        r.status === "error"
          ? "error"
          : diag?.stats?.budgetExhausted
            ? "budget-exhausted"
            : "completed",
      costUsd: systemCost(store, r.runId),
      latencyS: scalars?.latency_ms
        ? Math.round(scalars.latency_ms / 1000)
        : null,
    });
  }
  rows.sort(
    (a, b) =>
      String(a.system).localeCompare(String(b.system)) ||
      String(a.domain).localeCompare(String(b.domain)),
  );
  out({ commit: sha, runs: rows });
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      db: { type: "string" },
      baseline: { type: "string" },
      status: { type: "string" },
      id: { type: "string" },
      blocked: { type: "boolean" },
      role: { type: "string" },
      seq: { type: "string" },
      step: { type: "string" },
      grep: { type: "string" },
      head: { type: "string" },
      kind: { type: "string" },
      messages: { type: "boolean" },
      json: { type: "boolean" },
      cost: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const flags: Flags = {
    db: values.db ?? "eval-runs/draco-explore.db",
    baseline: values.baseline,
    status: values.status,
    id: values.id,
    blocked: Boolean(values.blocked),
    role: values.role,
    seq: values.seq,
    step: values.step,
    grep: values.grep,
    head: values.head,
    kind: values.kind,
    messages: Boolean(values.messages),
    json: Boolean(values.json),
    cost: Boolean(values.cost),
  };

  const store = new Store(flags.db);
  try {
    switch (command) {
      case "commits":
        return cmdCommits(store);
      case "commit":
        return cmdCommit(store, positionals, flags);
      case "case":
        return cmdCase(store, positionals);
      case "verdicts":
        return cmdVerdicts(store, positionals);
      case "rubric":
        return cmdRubric(store, positionals);
      case "report":
        return cmdReport(store, positionals);
      case "claims":
        return cmdClaims(store, positionals, flags);
      case "sources":
        return cmdSources(store, positionals, flags);
      case "citations":
        return cmdCitations(store, positionals);
      case "trace":
        return cmdTrace(store, positionals, flags);
      case "diagnostics":
        return cmdDiagnostics(store, positionals);
      case "cost":
        return cmdCost(store, positionals);
      case "blobs":
        return cmdBlobs(store, positionals);
      case "transcript":
        return cmdTranscript(store, positionals, flags);
      case "digest":
        return cmdDigest(store, positionals);
      case "spans":
        return cmdSpans(store, positionals, flags);
      case "runs":
        return cmdRuns(store, positionals);
      case "audit":
        return cmdAudit(store, positionals);
      case "diff":
        return cmdDiff(store, positionals);
      case "systems":
        return cmdSystems(store, positionals);
      case "quality":
        return cmdQuality(store, positionals);
      default:
        fail(`unknown command: ${command} (run with -h for usage)`);
    }
  } finally {
    store.close();
  }
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
