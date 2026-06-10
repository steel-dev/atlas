import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Append-only run history. Every benchmark run is its own row in `runs`
// (keyed by run_id, never overwritten), so repeated runs of the same
// (commit, case) all survive for variance and regression analysis. Heavy
// per-run artifacts — the byte-exact transcript, full claims, source bodies —
// live gzip-compressed in `run_blobs`, keyed by (run_id, kind), so the scalar
// table stays small and fast to scan while full visibility is one fetch away.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL, case_id TEXT NOT NULL,
  domain TEXT NOT NULL, status TEXT NOT NULL,
  normalized REAL, pass_rate REAL, criteria INTEGER, graded_criteria INTEGER,
  score_sd REAL,
  judge_errors INTEGER NOT NULL DEFAULT 0, finish_reason TEXT, error TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  research_provider TEXT, research_model TEXT, judge_provider TEXT, judge_model TEXT,
  grader TEXT, input_tokens INTEGER, output_tokens INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'run', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_commit ON runs(commit_sha);
CREATE INDEX IF NOT EXISTS idx_runs_commit_case ON runs(commit_sha, case_id);
CREATE TABLE IF NOT EXISTS run_blobs (
  run_id TEXT NOT NULL, kind TEXT NOT NULL,
  data BLOB NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind)
);
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY, domain TEXT NOT NULL, problem TEXT NOT NULL,
  rubric_id TEXT NOT NULL, criteria_count INTEGER NOT NULL,
  sections_json TEXT NOT NULL, criteria_json TEXT NOT NULL,
  cases_revision TEXT, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const RUN_COLS = [
  "run_id",
  "commit_sha",
  "case_id",
  "domain",
  "status",
  "normalized",
  "pass_rate",
  "criteria",
  "graded_criteria",
  "score_sd",
  "judge_errors",
  "finish_reason",
  "error",
  "latency_ms",
  "research_provider",
  "research_model",
  "judge_provider",
  "judge_model",
  "grader",
  "input_tokens",
  "output_tokens",
  "dirty",
  "source",
  "created_at",
];

const INSERT_RUN = `INSERT OR REPLACE INTO runs (${RUN_COLS.join(", ")})
VALUES (${RUN_COLS.map((c) => ":" + c).join(", ")})`;

const INSERT_BLOB = `INSERT OR REPLACE INTO run_blobs (run_id, kind, data, bytes)
VALUES (?, ?, ?, ?)`;

const INSERT_CASE = `INSERT INTO cases
  (case_id, domain, problem, rubric_id, criteria_count, sections_json, criteria_json, cases_revision, fetched_at)
VALUES (:case_id, :domain, :problem, :rubric_id, :criteria_count, :sections_json, :criteria_json, :cases_revision, :fetched_at)
ON CONFLICT(case_id) DO UPDATE SET
  domain=excluded.domain, problem=excluded.problem, rubric_id=excluded.rubric_id,
  criteria_count=excluded.criteria_count, sections_json=excluded.sections_json,
  criteria_json=excluded.criteria_json, cases_revision=excluded.cases_revision,
  fetched_at=excluded.fetched_at`;

const LATEST_PER_CASE = `
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY case_id ORDER BY created_at DESC, run_id DESC
    ) AS rn
    FROM runs WHERE commit_sha = ?
  ) WHERE rn = 1`;

export type BlobKind =
  | "score"
  | "report"
  | "markdown"
  | "metrics"
  | "usage"
  | "diagnostics"
  | "trace"
  | "claims"
  | "sources"
  | "citations"
  | "transcript";

const DETAIL_BLOB_KINDS: BlobKind[] = [
  "score",
  "report",
  "markdown",
  "metrics",
  "diagnostics",
];

export interface PersistableResult {
  id: string;
  domain?: string;
  score?: {
    normalizedScore?: number;
    passRate?: number;
    criteria?: number;
    gradedCriteria?: number;
    normalizedScoreSD?: number;
  } | null;
  report?: unknown[] | null;
  metrics?: {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  } | null;
  /** Per-model token usage breakdown for cost: { research, judge }. */
  usage?: unknown;
  diagnostics?: unknown;
  judgeErrors?: number;
  finishReason?: string;
  error?: string;
  markdown?: string;
  latencyMs?: number;
  /** Lightweight projected event timeline (EvalTraceEvent[]). */
  trace?: unknown;
  /** Full claim ledger: { confirmed, refuted, unverified } with quotes/votes. */
  claims?: unknown;
  /** Fetched source documents, including full extracted markdown. */
  sources?: unknown;
  /** { citedSources, citationsNotConfirmed, citationsNotFetched }. */
  citations?: unknown;
  /** Byte-exact model-step transcript (RecordedStep[]). */
  transcript?: unknown;
}

export interface RunMeta {
  runId: string;
  commitSha: string;
  dirty: boolean;
  source: string;
  researchProvider?: string | null;
  researchModel?: string | null;
  judgeProvider?: string | null;
  judgeModel?: string | null;
  grader?: string | null;
  createdAt: number;
}

export interface CaseInput {
  caseId: string;
  domain: string;
  problem: string;
  rubricId: string;
  criteriaCount: number;
  sectionsJson: string;
  criteriaJson: string;
  casesRevision: string | null;
}

export interface GridRow {
  caseId: string;
  domain: string;
  problem: string;
  criteriaCount: number;
  status: string | null;
  normalized: number | null;
  normalizedSD: number | null;
  passRate: number | null;
  gradedCriteria: number | null;
  criteria: number | null;
  judgeErrors: number | null;
  error: string | null;
  researchModel: string | null;
  judgeModel: string | null;
  dirty: boolean;
  createdAt: number | null;
  runId: string | null;
}

export interface CommitSummary {
  commitSha: string;
  runCount: number;
  totalRuns: number;
  scored: number;
  errors: number;
  avgNormalized: number | null;
  lastRun: number;
  anyDirty: boolean;
}

export interface CatalogCase {
  caseId: string;
  domain: string;
  problem: string;
  criteriaCount: number;
}

/** A single append-only run, newest-first, for repeat/regression analysis. */
export interface RunListRow {
  runId: string;
  commitSha: string;
  caseId: string;
  domain: string;
  status: string;
  normalized: number | null;
  passRate: number | null;
  judgeErrors: number | null;
  error: string | null;
  dirty: boolean;
  researchModel: string | null;
  judgeModel: string | null;
  createdAt: number;
}

export interface BlobInfo {
  kind: string;
  bytes: number;
}

function statusOf(r: PersistableResult): string {
  if (r.score) return "scored";
  if (r.error) return "error";
  return "ungraded";
}

function gz(text: string): Buffer {
  return gzipSync(Buffer.from(text, "utf8"));
}

function gunz(data: Uint8Array): string {
  return gunzipSync(data).toString("utf8");
}

// Pairs each present artifact with its kind and an uncompressed text form
// (markdown stays raw; everything else is JSON). Absent fields are skipped, so
// a run only carries the blobs it actually produced.
function blobPayloads(r: PersistableResult): Array<{
  kind: BlobKind;
  text: string;
}> {
  const out: Array<{ kind: BlobKind; text: string }> = [];
  const push = (kind: BlobKind, value: unknown, raw = false) => {
    if (value === undefined || value === null) return;
    out.push({ kind, text: raw ? String(value) : JSON.stringify(value) });
  };
  push("score", r.score);
  push("report", r.report);
  push("markdown", r.markdown, true);
  push("metrics", r.metrics);
  push("usage", r.usage);
  push("diagnostics", r.diagnostics);
  push("trace", r.trace);
  push("claims", r.claims);
  push("sources", r.sources);
  push("citations", r.citations);
  push("transcript", r.transcript);
  return out;
}

function runScalarParams(
  r: PersistableResult,
  meta: RunMeta,
): Record<string, string | number | null> {
  const score = r.score ?? null;
  const metrics = r.metrics ?? null;
  return {
    run_id: meta.runId,
    commit_sha: meta.commitSha,
    case_id: r.id,
    domain: r.domain ?? "Unknown",
    status: statusOf(r),
    normalized: score?.normalizedScore ?? null,
    pass_rate: score?.passRate ?? null,
    criteria:
      score?.criteria ?? (Array.isArray(r.report) ? r.report.length : null),
    graded_criteria: score?.gradedCriteria ?? null,
    score_sd: score?.normalizedScoreSD ?? null,
    judge_errors: r.judgeErrors ?? 0,
    finish_reason: r.finishReason ?? null,
    error: r.error ?? null,
    latency_ms: r.latencyMs ?? 0,
    research_provider: meta.researchProvider ?? metrics?.provider ?? null,
    research_model: meta.researchModel ?? metrics?.model ?? null,
    judge_provider: meta.judgeProvider ?? null,
    judge_model: meta.judgeModel ?? null,
    grader: meta.grader ?? null,
    input_tokens: metrics?.inputTokens ?? null,
    output_tokens: metrics?.outputTokens ?? null,
    dirty: meta.dirty ? 1 : 0,
    source: meta.source,
    created_at: meta.createdAt,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrateLegacyResults();
  }

  // One-time copy of any pre-append-only `results` rows into `runs` + blobs, so
  // historical commits stay visible after the schema change. Legacy rows lack a
  // transcript/claims/sources; we carry over what they had.
  private migrateLegacyResults(): void {
    if (this.getMeta("migrated_results_v1")) return;
    const hasResults = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='results'",
      )
      .get();
    if (!hasResults) {
      this.setMeta("migrated_results_v1", "1");
      return;
    }
    const rows = this.db.prepare("SELECT * FROM results").all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const runId = `legacy_${row.commit_sha}_${row.case_id}`;
      this.db.prepare(INSERT_RUN).run({
        run_id: runId,
        commit_sha: row.commit_sha as string,
        case_id: row.case_id as string,
        domain: (row.domain as string) ?? "Unknown",
        status: (row.status as string) ?? "ungraded",
        normalized: (row.normalized as number | null) ?? null,
        pass_rate: (row.pass_rate as number | null) ?? null,
        criteria: (row.criteria as number | null) ?? null,
        graded_criteria: (row.graded_criteria as number | null) ?? null,
        score_sd: (row.score_sd as number | null) ?? null,
        judge_errors: (row.judge_errors as number | null) ?? 0,
        finish_reason: (row.finish_reason as string | null) ?? null,
        error: (row.error as string | null) ?? null,
        latency_ms: (row.latency_ms as number | null) ?? 0,
        research_provider: (row.research_provider as string | null) ?? null,
        research_model: (row.research_model as string | null) ?? null,
        judge_provider: (row.judge_provider as string | null) ?? null,
        judge_model: (row.judge_model as string | null) ?? null,
        grader: (row.grader as string | null) ?? null,
        input_tokens: (row.input_tokens as number | null) ?? null,
        output_tokens: (row.output_tokens as number | null) ?? null,
        dirty: (row.dirty as number | null) ?? 0,
        source: (row.source as string | null) ?? "legacy",
        created_at: (row.created_at as number | null) ?? 0,
      });
      const legacyBlobs: Array<[BlobKind, unknown]> = [
        ["score", row.score_json],
        ["report", row.report_json],
        ["markdown", row.markdown],
        ["metrics", row.metrics_json],
        ["diagnostics", row.diagnostics_json],
      ];
      for (const [kind, value] of legacyBlobs) {
        if (typeof value !== "string" || value.length === 0) continue;
        this.db.prepare(INSERT_BLOB).run(runId, kind, gz(value), value.length);
      }
    }
    this.setMeta("migrated_results_v1", "1");
  }

  /** Appends a run (scalars + gzip artifact blobs) as a new immutable row. */
  insertRun(r: PersistableResult, meta: RunMeta): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(INSERT_RUN).run(runScalarParams(r, meta));
      this.db.prepare("DELETE FROM run_blobs WHERE run_id = ?").run(meta.runId);
      const insertBlob = this.db.prepare(INSERT_BLOB);
      for (const { kind, text } of blobPayloads(r)) {
        insertBlob.run(meta.runId, kind, gz(text), text.length);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  upsertCase(c: CaseInput): void {
    this.db.prepare(INSERT_CASE).run({
      case_id: c.caseId,
      domain: c.domain,
      problem: c.problem,
      rubric_id: c.rubricId,
      criteria_count: c.criteriaCount,
      sections_json: c.sectionsJson,
      criteria_json: c.criteriaJson,
      cases_revision: c.casesRevision,
      fetched_at: Date.now(),
    });
  }

  caseExists(caseId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM cases WHERE case_id = ?").get(caseId) !==
      undefined
    );
  }

  caseCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cases").get() as {
      n: number;
    };
    return row.n;
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  listCatalog(): CatalogCase[] {
    const rows = this.db
      .prepare(
        "SELECT case_id, domain, problem, criteria_count FROM cases ORDER BY domain, case_id",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      caseId: row.case_id as string,
      domain: row.domain as string,
      problem: row.problem as string,
      criteriaCount: row.criteria_count as number,
    }));
  }

  grid(commit: string): GridRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.case_id, c.domain, c.problem, c.criteria_count,
                r.status, r.normalized, r.score_sd, r.pass_rate, r.graded_criteria, r.criteria,
                r.judge_errors, r.error, r.research_model, r.judge_model,
                r.dirty, r.created_at, r.run_id
         FROM cases c
         LEFT JOIN (${LATEST_PER_CASE}) r ON r.case_id = c.case_id
         ORDER BY c.domain, c.case_id`,
      )
      .all(commit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      caseId: row.case_id as string,
      domain: row.domain as string,
      problem: row.problem as string,
      criteriaCount: row.criteria_count as number,
      status: (row.status as string | null) ?? null,
      normalized: (row.normalized as number | null) ?? null,
      normalizedSD: (row.score_sd as number | null) ?? null,
      passRate: (row.pass_rate as number | null) ?? null,
      gradedCriteria: (row.graded_criteria as number | null) ?? null,
      criteria: (row.criteria as number | null) ?? null,
      judgeErrors: (row.judge_errors as number | null) ?? null,
      error: (row.error as string | null) ?? null,
      researchModel: (row.research_model as string | null) ?? null,
      judgeModel: (row.judge_model as string | null) ?? null,
      dirty: Boolean(row.dirty),
      createdAt: (row.created_at as number | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
    }));
  }

  commits(): CommitSummary[] {
    const rows = this.db
      .prepare(
        `WITH latest AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY commit_sha, case_id ORDER BY created_at DESC, run_id DESC
           ) AS rn
           FROM runs
         ),
         totals AS (
           SELECT commit_sha, COUNT(*) AS total_runs,
                  MAX(created_at) AS last_run, MAX(dirty) AS any_dirty
           FROM runs GROUP BY commit_sha
         )
         SELECT l.commit_sha,
                COUNT(*) AS run_count,
                SUM(CASE WHEN l.status='scored' THEN 1 ELSE 0 END) AS scored,
                SUM(CASE WHEN l.status='error' THEN 1 ELSE 0 END) AS errors,
                AVG(l.normalized) AS avg_normalized,
                t.total_runs AS total_runs,
                t.last_run AS last_run, t.any_dirty AS any_dirty
         FROM latest l JOIN totals t ON t.commit_sha = l.commit_sha
         WHERE l.rn = 1
         GROUP BY l.commit_sha
         ORDER BY t.last_run DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      commitSha: row.commit_sha as string,
      runCount: row.run_count as number,
      totalRuns: row.total_runs as number,
      scored: row.scored as number,
      errors: row.errors as number,
      avgNormalized: (row.avg_normalized as number | null) ?? null,
      lastRun: row.last_run as number,
      anyDirty: Boolean(row.any_dirty),
    }));
  }

  // The latest run for (commit, case), shaped to mirror the old single-row
  // result: scalar columns plus the *_json/markdown artifacts (decompressed
  // from run_blobs) under their legacy names, so the web UI reads it unchanged.
  detail(commit: string, caseId: string): Record<string, unknown> | undefined {
    const run = this.db
      .prepare(
        `SELECT r.*, c.problem AS case_problem, c.domain AS case_domain,
                c.sections_json, c.criteria_json
         FROM runs r JOIN cases c ON c.case_id = r.case_id
         WHERE r.commit_sha = ? AND r.case_id = ?
         ORDER BY r.created_at DESC, r.run_id DESC LIMIT 1`,
      )
      .get(commit, caseId) as Record<string, unknown> | undefined;
    if (!run) return undefined;
    const blobs = this.blobs(run.run_id as string, DETAIL_BLOB_KINDS);
    return {
      ...run,
      score_json: blobs.score ?? null,
      report_json: blobs.report ?? null,
      markdown: blobs.markdown ?? null,
      metrics_json: blobs.metrics ?? null,
      diagnostics_json: blobs.diagnostics ?? null,
    };
  }

  caseRubric(caseId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        "SELECT case_id, domain, problem, rubric_id, sections_json, criteria_json FROM cases WHERE case_id = ?",
      )
      .get(caseId) as Record<string, unknown> | undefined;
  }

  unrunCaseIds(commit: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT case_id FROM cases
         WHERE case_id NOT IN (SELECT DISTINCT case_id FROM runs WHERE commit_sha = ?)
         ORDER BY domain, case_id`,
      )
      .all(commit) as Array<{ case_id: string }>;
    return rows.map((row) => row.case_id);
  }

  // --- analysis reads (append-only history + heavy artifacts) ---

  /** Every run for a commit (optionally one case), newest first. */
  listRuns(commit: string, caseId?: string): RunListRow[] {
    const rows = (
      caseId
        ? this.db
            .prepare(
              `SELECT * FROM runs WHERE commit_sha = ? AND case_id = ?
               ORDER BY created_at DESC, run_id DESC`,
            )
            .all(commit, caseId)
        : this.db
            .prepare(
              `SELECT * FROM runs WHERE commit_sha = ?
               ORDER BY created_at DESC, run_id DESC`,
            )
            .all(commit)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: row.run_id as string,
      commitSha: row.commit_sha as string,
      caseId: row.case_id as string,
      domain: row.domain as string,
      status: row.status as string,
      normalized: (row.normalized as number | null) ?? null,
      passRate: (row.pass_rate as number | null) ?? null,
      judgeErrors: (row.judge_errors as number | null) ?? null,
      error: (row.error as string | null) ?? null,
      dirty: Boolean(row.dirty),
      researchModel: (row.research_model as string | null) ?? null,
      judgeModel: (row.judge_model as string | null) ?? null,
      createdAt: row.created_at as number,
    }));
  }

  /** The full scalar row for one run, joined with its case metadata. */
  runScalars(runId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT r.*, c.problem AS case_problem, c.domain AS case_domain,
                c.sections_json, c.criteria_json
         FROM runs r LEFT JOIN cases c ON c.case_id = r.case_id
         WHERE r.run_id = ?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
  }

  /** Which artifacts a run stored, with their uncompressed byte sizes. */
  blobInfo(runId: string): BlobInfo[] {
    const rows = this.db
      .prepare(
        "SELECT kind, bytes FROM run_blobs WHERE run_id = ? ORDER BY kind",
      )
      .all(runId) as Array<{ kind: string; bytes: number }>;
    return rows.map((row) => ({ kind: row.kind, bytes: row.bytes }));
  }

  /** One decompressed artifact (markdown raw, everything else a JSON string). */
  getBlob(runId: string, kind: string): string | undefined {
    const row = this.db
      .prepare("SELECT data FROM run_blobs WHERE run_id = ? AND kind = ?")
      .get(runId, kind) as { data: Uint8Array } | undefined;
    return row ? gunz(row.data) : undefined;
  }

  private blobs(
    runId: string,
    kinds: BlobKind[],
  ): Partial<Record<BlobKind, string>> {
    const out: Partial<Record<BlobKind, string>> = {};
    for (const kind of kinds) {
      const value = this.getBlob(runId, kind);
      if (value !== undefined) out[kind] = value;
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
