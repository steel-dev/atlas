import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ModelProvider,
  ResearchEvent,
  ResearchResult,
} from "../src/research.js";

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
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

export type EvalTraceEvent = {
  atMs: number;
  event: ResearchEvent["type"];
  index?: number;
  query?: string;
  count?: number;
  results?: Array<{
    url: string;
    domain: string;
    title?: string;
    snippet?: string;
  }>;
  strategy?: string;
  angles?: Array<{ label: string; query: string }>;
  url?: string;
  title?: string;
  method?: string;
  error?: string;
  reason?: string;
  retryAfterSeconds?: number;
  attempt?: number;
  maxAttempts?: number;
  attempts?: Array<{ method: string; ok: boolean; note: string }>;
  qualityWarnings?: string[];
  sourceId?: string;
  unsupported?: number;
  clustersFormed?: number;
  claimsDeduped?: number;
  claims?: number;
  id?: string;
  claim?: string;
  vote?: string;
  status?: string;
  confirmed?: number;
  refuted?: number;
  unverified?: number;
  sourcesFetched?: number;
  markdownChars?: number;
  tokensBefore?: number;
  droppedMessages?: number;
  tool?: string;
  data?: unknown;
  result?: {
    citedSources: number;
    citationsNotFetched: number;
    markdownChars: number;
    confirmed: number;
  };
};

export function traceEvent(
  event: ResearchEvent,
  started: number,
): EvalTraceEvent {
  const base = { atMs: Date.now() - started, event: event.type };
  switch (event.type) {
    case "scope_completed":
      return { ...base, strategy: event.strategy, angles: event.angles };
    case "searching":
      return { ...base, index: event.index, query: event.query };
    case "search_results":
      return {
        ...base,
        index: event.index,
        count: event.count,
        ...(event.results ? { results: event.results } : {}),
      };
    case "search_failed":
      return { ...base, index: event.index, error: event.error };
    case "fetching":
      return { ...base, url: event.url };
    case "rate_limited":
      return {
        ...base,
        retryAfterSeconds: event.retryAfterSeconds,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
    case "source_fetched":
      return {
        ...base,
        url: event.url,
        title: event.title,
        ...(event.method ? { method: event.method } : {}),
        ...(event.markdownChars !== undefined
          ? { markdownChars: event.markdownChars }
          : {}),
        ...(event.attempts ? { attempts: event.attempts } : {}),
        ...(event.qualityWarnings
          ? { qualityWarnings: event.qualityWarnings }
          : {}),
      };
    case "source_error":
      return { ...base, url: event.url, error: event.error };
    case "claims_extracted":
      return {
        ...base,
        sourceId: event.sourceId,
        url: event.url,
        count: event.count,
        unsupported: event.unsupported,
        ...(event.error ? { error: event.error } : {}),
      };
    case "claims_clustered":
      return {
        ...base,
        clustersFormed: event.clustersFormed,
        claimsDeduped: event.claimsDeduped,
      };
    case "verify_started":
      return { ...base, claims: event.claims };
    case "claim_verified":
      return {
        ...base,
        id: event.id,
        claim: event.claim,
        vote: event.vote,
        status: event.status,
      };
    case "verify_finished":
      return {
        ...base,
        confirmed: event.confirmed,
        refuted: event.refuted,
        unverified: event.unverified,
      };
    case "research_finished":
      return { ...base, sourcesFetched: event.sourcesFetched };
    case "context_reanchored":
      return {
        ...base,
        tokensBefore: event.tokensBefore,
        droppedMessages: event.droppedMessages,
      };
    case "citations_not_fetched":
      return { ...base, count: event.count };
    case "written":
      return { ...base, markdownChars: event.markdownChars };
    case "completed":
      return {
        ...base,
        result: {
          citedSources: event.result.citedSources.length,
          citationsNotFetched: event.result.citationsNotFetched.length,
          markdownChars: event.result.markdown.length,
          confirmed: event.result.claims.confirmed.length,
        },
      };
    case "tool_event":
      return {
        ...base,
        tool: event.tool,
        ...(event.data !== undefined ? { data: event.data } : {}),
      };
    case "synthesis_failed":
      return {
        ...base,
        reason: event.reason,
        ...(event.error ? { error: event.error } : {}),
      };
    case "research_started":
    case "report_boundary":
    case "report_delta":
      return base;
  }
}

export function progressLine(
  caseId: string,
  event: ResearchEvent,
): string | null {
  switch (event.type) {
    case "scope_completed":
      return `${caseId}: scoped into ${event.angles.length} angle(s): ${event.angles.map((angle) => angle.label).join(", ")}`;
    case "searching":
      return `${caseId}: search[${event.index}] ${event.query}`;
    case "search_results":
      return `${caseId}: search[${event.index}] ${event.count} result(s)`;
    case "search_failed":
      return `${caseId}: search[${event.index}] failed: ${event.error}`;
    case "fetching":
      return `${caseId}: fetch ${event.url}`;
    case "source_fetched":
      return `${caseId}: fetched ${event.url}${event.method ? ` (${event.method})` : ""}`;
    case "source_error":
      return `${caseId}: source error ${event.url}: ${event.error}`;
    case "claims_extracted":
      return event.error
        ? `${caseId}: claim extraction failed for ${event.url}: ${event.error}`
        : `${caseId}: ${event.count} claim(s) from ${event.url}${event.unsupported ? ` (${event.unsupported} unsupported)` : ""}`;
    case "claims_clustered":
      return `${caseId}: merged ${event.claimsDeduped} duplicate claim(s) into ${event.clustersFormed} cluster(s)`;
    case "verify_started":
      return `${caseId}: verifying ${event.claims} claim(s)`;
    case "claim_verified":
      return `${caseId}: claim ${event.id} ${event.vote} ${event.status}`;
    case "verify_finished":
      return `${caseId}: verify done — ${event.confirmed} confirmed, ${event.refuted} refuted, ${event.unverified} unverified`;
    case "rate_limited":
      return `${caseId}: rate limited, waiting ${event.retryAfterSeconds}s`;
    case "research_finished":
      return `${caseId}: research finished with ${event.sourcesFetched} source(s)`;
    case "context_reanchored":
      return `${caseId}: context re-anchored (~${Math.round(event.tokensBefore / 1000)}k tok dropped)`;
    case "citations_not_fetched":
      return `${caseId}: ${event.count} citation(s) not fetched`;
    case "written":
      return `${caseId}: wrote ${event.markdownChars} markdown chars`;
    case "synthesis_failed":
      return `${caseId}: synthesis failed (${event.reason}${event.error ? `: ${event.error}` : ""}) — falling back to raw claims`;
    case "completed":
    case "research_started":
    case "report_boundary":
    case "report_delta":
    case "tool_event":
      return null;
  }
}

export interface RunMetrics {
  provider: ModelProvider;
  model: string;
  finishReason: string;
  leadToolCalls: number;
  surveys: number;
  reanchors: number;
  angles: number;
  sourcesFetched: number;
  claimsExtracted: number;
  claimsUnsupported: number;
  claimsVerified: number;
  confirmed: number;
  refuted: number;
  unverified: number;
  beyondVerifyCap: number;
  citedSources: number;
  citationsNotFetched: number;
  inputTokens: number;
  outputTokens: number;
}

export function summarizeRun(result: ResearchResult): RunMetrics {
  return {
    provider: result.provider,
    model: result.model,
    finishReason: result.finishReason,
    leadToolCalls: result.stats.leadToolCalls,
    surveys: result.stats.surveys,
    reanchors: result.stats.reanchors,
    angles: result.stats.angles,
    sourcesFetched: result.stats.sourcesFetched,
    claimsExtracted: result.stats.claimsExtracted,
    claimsUnsupported: result.stats.claimsUnsupported,
    claimsVerified: result.stats.claimsVerified,
    confirmed: result.stats.confirmed,
    refuted: result.stats.refuted,
    unverified: result.stats.unverified,
    beyondVerifyCap: result.stats.beyondVerifyCap,
    citedSources: result.citedSources.length,
    citationsNotFetched: result.citationsNotFetched.length,
    inputTokens:
      result.usage.input_tokens +
      result.usage.cache_creation_input_tokens +
      result.usage.cache_read_input_tokens,
    outputTokens: result.usage.output_tokens,
  };
}

export interface EvalDiagnostics {
  search: {
    events: number;
  };
  fetch: {
    fetched: number;
    rejected: number;
    fetchedByMethod: Record<string, number>;
    failedAttemptsByMethod: Record<string, number>;
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
    refuted: number;
    unverified: number;
    votesByStatus: Record<string, number>;
  };
  cost: {
    latencyMs: number;
    leadToolCalls?: number;
    surveys?: number;
    reanchors?: number;
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
  const failedAttemptsByMethod: Record<string, number> = {};
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
  let claimsExtracted = 0;
  let claimsUnsupported = 0;
  let extractionErrors = 0;
  let verified = 0;
  let confirmed = 0;
  let refutedCount = 0;
  let unverified = 0;

  for (const event of opts.trace) {
    if (!event) continue;
    if (event.event === "searching") {
      searchEvents++;
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
      for (const attempt of event.attempts ?? []) {
        if (!attempt.ok) increment(failedAttemptsByMethod, attempt.method);
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
    if (event.event === "verify_finished") {
      confirmed += event.confirmed ?? 0;
      refutedCount += event.refuted ?? 0;
      unverified += event.unverified ?? 0;
    }
  }

  return {
    search: { events: searchEvents },
    fetch: {
      fetched,
      rejected,
      fetchedByMethod,
      failedAttemptsByMethod,
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
      confirmed,
      refuted: refutedCount,
      unverified,
      votesByStatus,
    },
    cost: {
      latencyMs: opts.latencyMs,
      ...(opts.metrics
        ? {
            leadToolCalls: opts.metrics.leadToolCalls,
            surveys: opts.metrics.surveys,
            reanchors: opts.metrics.reanchors,
            inputTokens: opts.metrics.inputTokens,
            outputTokens: opts.metrics.outputTokens,
          }
        : {}),
    },
  };
}
