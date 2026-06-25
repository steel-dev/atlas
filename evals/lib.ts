import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ResearchEvent, ResearchResult, RunStats } from "../src/index.js";

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function hostFromUrl(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "invalid";
  }
}

export function codeFromMessage(message: string | undefined): string {
  if (!message) return "unknown";
  const match = message.match(/^([a-z_]+):/i);
  return match?.[1] ?? "unknown";
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key}:${value}`).join(",");
}

export function isTransientResearchError(message: string): boolean {
  return /rate limit|concurrent connections|overloaded|temporarily|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b(408|429|500|502|503|504)\b/i.test(
    message,
  );
}

export async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(
    resolved,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

export type EvalTraceEventName =
  | "research_started"
  | "plan_updated"
  | "lead_recontexted"
  | "checklist_built"
  | "coverage_assessed"
  | "agent_spawned"
  | "agent_returned"
  | "search_results"
  | "search_failed"
  | "source_fetched"
  | "source_error"
  | "claim_extracted"
  | "claims_extracted"
  | "claim_verified"
  | "report_drafting"
  | "citation_bound"
  | "budget_warning"
  | "safety_flag"
  | "pricing_missing"
  | "rate_limited"
  | "tool_event"
  | "completed"
  | "run_error";

export type EvalTraceEvent = {
  atMs: number;
  event: EvalTraceEventName;
  query?: string;
  provider?: string;
  count?: number;
  url?: string;
  title?: string;
  method?: string;
  markdownChars?: number;
  qualityWarnings?: string[];
  error?: string;
  reason?: string;
  sourceId?: string;
  unsupported?: number;
  id?: string;
  status?: string;
  vote?: string;
  ok?: boolean;
  agentId?: string;
  parentId?: string;
  role?: string;
  task?: string;
  depth?: number;
  grantUSD?: number;
  note?: string;
  claimsAdded?: number;
  spentUSD?: number;
  stopReason?: string;
  retryAfterSeconds?: number;
  kind?: string;
  detail?: string;
  limitUSD?: number;
  fraction?: number;
  tool?: string;
  data?: unknown;
  stats?: RunStats;
};

export function traceEvent(
  event: ResearchEvent,
  started: number,
): EvalTraceEvent | null {
  const base = (name: EvalTraceEventName): EvalTraceEvent => ({
    atMs: Date.now() - started,
    event: name,
  });
  switch (event.type) {
    case "run.started":
      return base("research_started");
    case "plan.updated":
      return { ...base("plan_updated"), reason: event.rationale };
    case "lead.recontexted":
      return base("lead_recontexted");
    case "checklist.built":
      return {
        ...base("checklist_built"),
        data: {
          items: event.items,
          central: event.central,
          volatile: event.volatile,
        },
      };
    case "coverage.assessed":
      return {
        ...base("coverage_assessed"),
        data: { answered: event.answered, gaps: event.gaps },
      };
    case "agent.spawned":
      return {
        ...base("agent_spawned"),
        agentId: event.agentId,
        ...(event.parentId ? { parentId: event.parentId } : {}),
        role: event.role,
        task: event.task,
        grantUSD: event.grantUSD,
        depth: event.depth,
      };
    case "agent.returned":
      return {
        ...base("agent_returned"),
        agentId: event.agentId,
        role: event.role,
        note: event.note,
        claimsAdded: event.claimsAdded,
        spentUSD: event.spentUSD,
        stopReason: event.stopReason,
      };
    case "search.completed":
      return {
        ...base("search_results"),
        query: event.query,
        provider: event.provider,
        count: event.results,
      };
    case "search.failed":
      return {
        ...base("search_failed"),
        query: event.query,
        error: event.error,
      };
    case "source.fetched":
      return {
        ...base("source_fetched"),
        sourceId: event.sourceId,
        url: event.url,
        title: event.title,
        method: event.via,
        markdownChars: event.chars,
        ...(event.warnings ? { qualityWarnings: event.warnings } : {}),
      };
    case "source.failed":
      return { ...base("source_error"), url: event.url, error: event.reason };
    case "extraction.completed":
      return {
        ...base("claims_extracted"),
        sourceId: event.sourceId,
        url: event.url,
        count: event.count,
        unsupported: event.unsupported,
        ...(event.error ? { error: event.error } : {}),
      };
    case "claim.extracted":
      return {
        ...base("claim_extracted"),
        id: event.claimId,
        sourceId: event.sourceId,
        data: { text: event.text, importance: event.importance },
      };
    case "claim.verified":
      return {
        ...base("claim_verified"),
        id: event.claimId,
        status: event.status,
        vote: event.votes,
      };
    case "report.drafting":
      return base("report_drafting");
    case "citation.bound":
      return { ...base("citation_bound"), id: event.claimId, ok: event.ok };
    case "budget.warning":
      return {
        ...base("budget_warning"),
        spentUSD: event.spentUSD,
        limitUSD: event.limitUSD,
        fraction: event.fraction,
      };
    case "safety.flag":
      return {
        ...base("safety_flag"),
        kind: event.kind,
        detail: event.detail,
        ...(event.url ? { url: event.url } : {}),
      };
    case "rate.limited":
      return {
        ...base("rate_limited"),
        retryAfterSeconds: event.retryAfterSeconds,
      };
    case "tool.event":
      return {
        ...base("tool_event"),
        tool: event.tool,
        ...(event.data !== undefined ? { data: event.data } : {}),
      };
    case "run.completed":
      return { ...base("completed"), stats: event.stats };
    case "run.error":
      return { ...base("run_error"), error: event.message };
    case "pricing.missing":
      return {
        ...base("pricing_missing"),
        id: event.modelId,
        detail: event.detail,
      };
    case "model.fallback":
      return {
        ...base("pricing_missing"),
        id: event.modelId,
        detail: event.detail,
      };
    case "report.delta":
    case "report.reset":
    case "report.completed":
    case "run_code.unavailable":
      return null;
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function progressLine(
  caseId: string,
  event: ResearchEvent,
): string | null {
  switch (event.type) {
    case "plan.updated":
      return `${caseId}: plan updated — ${truncate(event.rationale, 140)}`;
    case "lead.recontexted":
      return `${caseId}: lead re-anchored in a fresh context (session ${event.session})`;
    case "coverage.assessed":
      return event.answered
        ? `${caseId}: coverage audit round ${event.round}: answered`
        : `${caseId}: coverage audit round ${event.round}: ${event.gaps.length} gap(s) — ${truncate(event.gaps.join("; "), 120)}`;
    case "agent.spawned":
      return `${caseId}: agent ${event.agentId} spawned (${event.role}, depth ${event.depth}, $${event.grantUSD.toFixed(2)}): ${truncate(event.task, 100)}`;
    case "agent.returned":
      return `${caseId}: agent ${event.agentId} returned (${event.role}, ${event.stopReason}) — +${event.claimsAdded} claim(s), $${event.spentUSD.toFixed(2)} spent`;
    case "search.completed":
      return `${caseId}: search "${truncate(event.query, 80)}" → ${event.results} result(s) [${event.provider}]`;
    case "search.failed":
      return `${caseId}: search "${truncate(event.query, 80)}" failed: ${event.error}`;
    case "source.fetched":
      return `${caseId}: fetched ${event.url} (${event.via}, ${event.chars} chars)`;
    case "source.failed":
      return `${caseId}: source error ${event.url}: ${event.reason}`;
    case "extraction.completed":
      return event.error
        ? `${caseId}: claim extraction failed for ${event.url}: ${event.error}`
        : `${caseId}: ${event.count} claim(s) from ${event.url}${event.unsupported ? ` (${event.unsupported} unsupported)` : ""}`;
    case "claim.verified":
      return `${caseId}: claim ${event.claimId} ${event.status} (${event.votes})`;
    case "report.drafting":
      return `${caseId}: drafting report`;
    case "citation.bound":
      return event.ok
        ? null
        : `${caseId}: unsupported sentence: ${truncate(event.sentence, 100)}`;
    case "budget.warning":
      return `${caseId}: budget ${Math.round(event.fraction * 100)}% used ($${event.spentUSD.toFixed(2)}/$${event.limitUSD.toFixed(2)})`;
    case "safety.flag":
      return `${caseId}: safety flag ${event.kind}: ${truncate(event.detail, 120)}`;
    case "pricing.missing":
    case "model.fallback":
      return `${caseId}: ${truncate(event.detail, 120)}`;
    case "rate.limited":
      return `${caseId}: rate limited, waiting ${event.retryAfterSeconds}s`;
    case "run.error":
      return `${caseId}: run error${event.recoverable ? " (recoverable)" : ""}: ${event.message}`;
    case "run.started":
    case "run.completed":
    case "claim.extracted":
    case "report.delta":
    case "report.reset":
    case "report.completed":
    case "tool.event":
    case "run_code.unavailable":
      return null;
  }
}

export interface RunMetrics {
  effort: string;
  searches: number;
  sourcesFetched: number;
  sourcesFailed: number;
  claimsExtracted: number;
  claimsUnsupported: number;
  claimsVerified: number;
  confirmed: number;
  contested: number;
  refuted: number;
  citationsBound: number;
  citationsUnsupported: number;
  dupesDropped: number;
  agentsSpawned: number;
  maxDepth: number;
  singleAgent: boolean;
  costUSD: number;
  durationMs: number;
  budgetExhausted: boolean;
  inputTokens: number;
  outputTokens: number;
}

export function summarizeRun(result: ResearchResult): RunMetrics {
  const stats = result.stats;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of Object.values(stats.tokens)) {
    inputTokens += usage.input;
    outputTokens += usage.output;
  }
  return {
    effort: stats.effort,
    searches: stats.searches,
    sourcesFetched: stats.sourcesFetched,
    sourcesFailed: stats.sourcesFailed,
    claimsExtracted: stats.claimsExtracted,
    claimsUnsupported: stats.claimsUnsupported,
    claimsVerified: stats.claimsVerified,
    confirmed: stats.claimsConfirmed,
    contested: stats.claimsContested,
    refuted: stats.claimsRefuted,
    citationsBound: stats.citationsBound,
    citationsUnsupported: stats.citationsUnsupported,
    dupesDropped: stats.dupesDropped,
    agentsSpawned: stats.agentsSpawned,
    maxDepth: stats.maxDepth,
    singleAgent: stats.singleAgent,
    costUSD: stats.costUSD,
    durationMs: stats.durationMs,
    budgetExhausted: stats.budgetExhausted,
    inputTokens,
    outputTokens,
  };
}

export interface EvalDiagnostics {
  search: {
    events: number;
    failed: number;
  };
  fetch: {
    fetched: number;
    rejected: number;
    fetchedByMethod: Record<string, number>;
    qualityWarningsByCode: Record<string, number>;
    sourceErrorsByCode: Record<string, number>;
    fetchedHosts: Record<string, number>;
    rejectedHosts: Record<string, number>;
    blockedOrThinSources: number;
    blockedOrThinByHost: Record<string, number>;
    totalFetchedMarkdownChars: number;
  };
  claims: {
    extracted: number;
    unsupported: number;
    extractionErrors: number;
    verified: number;
    confirmed: number;
    contested: number;
    refuted: number;
    unverified: number;
    votesByStatus: Record<string, number>;
  };
  citations: {
    bound: number;
    unsupported: number;
  };
  cost: {
    latencyMs: number;
    costUSD?: number;
    agentsSpawned?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export function isBlockedOrThin(warnings: string[] | undefined): boolean {
  return (warnings ?? []).some((warning) =>
    /\b(?:blocked_or_challenge|thin_content|error_page)\b/i.test(warning),
  );
}

export function buildDiagnostics(opts: {
  trace: EvalTraceEvent[];
  latencyMs: number;
  metrics?: RunMetrics;
}): EvalDiagnostics {
  const fetchedByMethod: Record<string, number> = {};
  const qualityWarningsByCode: Record<string, number> = {};
  const sourceErrorsByCode: Record<string, number> = {};
  const fetchedHosts: Record<string, number> = {};
  const rejectedHosts: Record<string, number> = {};
  const blockedOrThinByHost: Record<string, number> = {};
  const votesByStatus: Record<string, number> = {};
  let blockedOrThinSources = 0;
  let fetched = 0;
  let rejected = 0;
  let totalFetchedMarkdownChars = 0;
  let searchEvents = 0;
  let searchFailures = 0;
  let claimsExtracted = 0;
  let claimsUnsupported = 0;
  let extractionErrors = 0;
  let verified = 0;
  let citationsBound = 0;
  let citationsUnsupported = 0;

  for (const event of opts.trace) {
    if (!event) continue;
    if (event.event === "search_results") {
      searchEvents++;
      continue;
    }
    if (event.event === "search_failed") {
      searchEvents++;
      searchFailures++;
      continue;
    }
    if (event.event === "source_fetched") {
      fetched++;
      increment(fetchedByMethod, event.method ?? "unknown");
      increment(fetchedHosts, hostFromUrl(event.url));
      totalFetchedMarkdownChars += event.markdownChars ?? 0;
      if (isBlockedOrThin(event.qualityWarnings)) {
        blockedOrThinSources++;
        increment(blockedOrThinByHost, hostFromUrl(event.url));
      }
      for (const warning of event.qualityWarnings ?? []) {
        increment(qualityWarningsByCode, codeFromMessage(warning));
      }
      continue;
    }
    if (event.event === "source_error") {
      rejected++;
      increment(rejectedHosts, hostFromUrl(event.url));
      increment(sourceErrorsByCode, codeFromMessage(event.error));
      continue;
    }
    if (event.event === "claims_extracted") {
      claimsExtracted += event.count ?? 0;
      claimsUnsupported += event.unsupported ?? 0;
      if (event.error) extractionErrors++;
      continue;
    }
    if (event.event === "claim_verified") {
      verified++;
      increment(votesByStatus, event.status ?? "unknown");
      continue;
    }
    if (event.event === "citation_bound") {
      if (event.ok) citationsBound++;
      else citationsUnsupported++;
    }
  }

  return {
    search: { events: searchEvents, failed: searchFailures },
    fetch: {
      fetched,
      rejected,
      fetchedByMethod,
      qualityWarningsByCode,
      sourceErrorsByCode,
      fetchedHosts,
      rejectedHosts,
      blockedOrThinSources,
      blockedOrThinByHost,
      totalFetchedMarkdownChars,
    },
    claims: {
      extracted: claimsExtracted,
      unsupported: claimsUnsupported,
      extractionErrors,
      verified,
      confirmed: votesByStatus.confirmed ?? 0,
      contested: votesByStatus.contested ?? 0,
      refuted: votesByStatus.refuted ?? 0,
      unverified: votesByStatus.unverified ?? 0,
      votesByStatus,
    },
    citations: {
      bound: citationsBound,
      unsupported: citationsUnsupported,
    },
    cost: {
      latencyMs: opts.latencyMs,
      ...(opts.metrics
        ? {
            costUSD: opts.metrics.costUSD,
            agentsSpawned: opts.metrics.agentsSpawned,
            inputTokens: opts.metrics.inputTokens,
            outputTokens: opts.metrics.outputTokens,
          }
        : {}),
    },
  };
}
