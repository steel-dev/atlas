import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { captureCommit } from "./git.js";
import { runCost, type RunUsage } from "./pricing.js";

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

History:
  runs <sha> [<caseId>]           Every run (append-only), newest first

Options:
  --db PATH    SQLite path (default: eval-runs/draco-explore.db)
  --json       Force JSON output (default for structured commands)
`;

function fail(message: string): never {
  process.stderr.write(`draco-query: ${message}\n`);
  process.exit(1);
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function raw(text: string): void {
  process.stdout.write(text + "\n");
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
    runs: store
      .listRuns(sha, caseId)
      .map((r) => ({ runId: r.runId, normalized: r.normalized, createdAt: r.createdAt })),
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
      `no '${kind}' for run ${runId} (available: ${store
        .blobInfo(runId)
        .map((b) => b.kind)
        .join(", ") || "none"})`,
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
  out(parseJson(blobOrFail(store, need(positionals, 1, "runId"), "diagnostics")));
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

function cmdTranscript(store: Store, positionals: string[], flags: Flags): void {
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
        re.test(JSON.stringify(s.output)) || re.test(JSON.stringify(s.messages)),
    );
  }
  if (flags.head) selected = selected.slice(0, Number(flags.head));

  if (selected.length === 0) {
    raw("(no steps matched)");
    return;
  }
  raw(selected.map((s) => renderStep(s, flags.messages)).join("\n\n"));
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
      case "runs":
        return cmdRuns(store, positionals);
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
