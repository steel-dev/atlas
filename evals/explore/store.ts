import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS results (
  commit_sha TEXT NOT NULL, case_id TEXT NOT NULL,
  domain TEXT NOT NULL, status TEXT NOT NULL,
  normalized REAL, pass_rate REAL, criteria INTEGER, graded_criteria INTEGER,
  judge_errors INTEGER NOT NULL DEFAULT 0, finish_reason TEXT, error TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  research_provider TEXT, research_model TEXT, judge_provider TEXT, judge_model TEXT,
  grader TEXT, input_tokens INTEGER, output_tokens INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'run', created_at INTEGER NOT NULL,
  score_json TEXT, report_json TEXT, markdown TEXT,
  metrics_json TEXT, diagnostics_json TEXT, score_sd REAL,
  PRIMARY KEY (commit_sha, case_id)
);
CREATE INDEX IF NOT EXISTS idx_results_commit ON results(commit_sha);
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY, domain TEXT NOT NULL, problem TEXT NOT NULL,
  rubric_id TEXT NOT NULL, criteria_count INTEGER NOT NULL,
  sections_json TEXT NOT NULL, criteria_json TEXT NOT NULL,
  cases_revision TEXT, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const RESULT_COLS = [
  "commit_sha",
  "case_id",
  "domain",
  "status",
  "normalized",
  "pass_rate",
  "criteria",
  "graded_criteria",
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
  "score_json",
  "report_json",
  "markdown",
  "metrics_json",
  "diagnostics_json",
  "score_sd",
];

const INSERT_RESULT = `INSERT INTO results (${RESULT_COLS.join(", ")})
VALUES (${RESULT_COLS.map((c) => ":" + c).join(", ")})
ON CONFLICT(commit_sha, case_id) DO UPDATE SET ${RESULT_COLS.filter(
  (c) => c !== "commit_sha" && c !== "case_id",
)
  .map((c) => `${c}=excluded.${c}`)
  .join(", ")}`;

const INSERT_CASE = `INSERT INTO cases
  (case_id, domain, problem, rubric_id, criteria_count, sections_json, criteria_json, cases_revision, fetched_at)
VALUES (:case_id, :domain, :problem, :rubric_id, :criteria_count, :sections_json, :criteria_json, :cases_revision, :fetched_at)
ON CONFLICT(case_id) DO UPDATE SET
  domain=excluded.domain, problem=excluded.problem, rubric_id=excluded.rubric_id,
  criteria_count=excluded.criteria_count, sections_json=excluded.sections_json,
  criteria_json=excluded.criteria_json, cases_revision=excluded.cases_revision,
  fetched_at=excluded.fetched_at`;

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
  diagnostics?: unknown;
  judgeErrors?: number;
  finishReason?: string;
  error?: string;
  markdown?: string;
  latencyMs?: number;
}

export interface RunMeta {
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
}

export interface CommitSummary {
  commitSha: string;
  runCount: number;
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

function statusOf(r: PersistableResult): string {
  if (r.score) return "scored";
  if (r.error) return "error";
  return "ungraded";
}

function resultParams(
  r: PersistableResult,
  meta: RunMeta,
): Record<string, string | number | null> {
  const score = r.score ?? null;
  const metrics = r.metrics ?? null;
  return {
    commit_sha: meta.commitSha,
    case_id: r.id,
    domain: r.domain ?? "Unknown",
    status: statusOf(r),
    normalized: score?.normalizedScore ?? null,
    pass_rate: score?.passRate ?? null,
    criteria:
      score?.criteria ?? (Array.isArray(r.report) ? r.report.length : null),
    graded_criteria: score?.gradedCriteria ?? null,
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
    score_json: r.score != null ? JSON.stringify(r.score) : null,
    report_json: r.report != null ? JSON.stringify(r.report) : null,
    markdown: r.markdown ?? null,
    metrics_json: r.metrics != null ? JSON.stringify(r.metrics) : null,
    diagnostics_json:
      r.diagnostics != null ? JSON.stringify(r.diagnostics) : null,
    score_sd: r.score?.normalizedScoreSD ?? null,
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
    try {
      this.db.exec("ALTER TABLE results ADD COLUMN score_sd REAL");
    } catch {
      /* column already exists */
    }
  }

  upsertResult(r: PersistableResult, meta: RunMeta): void {
    this.db.prepare(INSERT_RESULT).run(resultParams(r, meta));
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
                r.dirty, r.created_at
         FROM cases c
         LEFT JOIN results r ON r.case_id = c.case_id AND r.commit_sha = ?
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
    }));
  }

  commits(): CommitSummary[] {
    const rows = this.db
      .prepare(
        `SELECT commit_sha,
                COUNT(*) AS run_count,
                SUM(CASE WHEN status='scored' THEN 1 ELSE 0 END) AS scored,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
                AVG(normalized) AS avg_normalized,
                MAX(created_at) AS last_run,
                MAX(dirty) AS any_dirty
         FROM results GROUP BY commit_sha ORDER BY MAX(created_at) DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      commitSha: row.commit_sha as string,
      runCount: row.run_count as number,
      scored: row.scored as number,
      errors: row.errors as number,
      avgNormalized: (row.avg_normalized as number | null) ?? null,
      lastRun: row.last_run as number,
      anyDirty: Boolean(row.any_dirty),
    }));
  }

  detail(
    commit: string,
    caseId: string,
  ): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT r.*, c.problem AS case_problem, c.domain AS case_domain,
                c.sections_json, c.criteria_json
         FROM results r JOIN cases c ON c.case_id = r.case_id
         WHERE r.commit_sha = ? AND r.case_id = ?`,
      )
      .get(commit, caseId) as Record<string, unknown> | undefined;
  }

  caseRubric(caseId: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        "SELECT case_id, domain, problem, sections_json, criteria_json FROM cases WHERE case_id = ?",
      )
      .get(caseId) as Record<string, unknown> | undefined;
  }

  unrunCaseIds(commit: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT case_id FROM cases
         WHERE case_id NOT IN (SELECT case_id FROM results WHERE commit_sha = ?)
         ORDER BY domain, case_id`,
      )
      .all(commit) as Array<{ case_id: string }>;
    return rows.map((row) => row.case_id);
  }

  close(): void {
    this.db.close();
  }
}
