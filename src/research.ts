import Anthropic from "@anthropic-ai/sdk";
import {
  assessCoverage,
  parseCitations,
  planBriefAndSubQuestions,
  summarizeWebpage,
  verifyClaim,
  writeReport,
  type CitedSource,
  type ParsedClaim,
  type UnsupportedClaim,
} from "./pipeline.js";
import { webSearch, type Engine, type SearchResult } from "./search.js";
import { createSteel } from "./steel.js";

const MAX_WRITE_ATTEMPTS = 2;
const VERIFY_BATCH = 3;
const PER_DOMAIN_CAP = 2;
const MAX_ADDITIONAL_QUERIES = 3;

export type { CitedSource, ParsedClaim, UnsupportedClaim } from "./pipeline.js";
export type { Engine, SearchResult } from "./search.js";

export interface ClaimVerification {
  claim: string;
  source_n: number;
  source_url: string | null;
  source_title: string | null;
  supported: boolean;
  reason: string;
}

export interface AssessmentRecord {
  round: number;
  sufficient: boolean;
  gaps: string[];
  additional_queries: string[];
  reason?: string;
}

export interface VerificationSummary {
  total: number;
  supported: number;
  unsupported: number;
  pass_rate: number;
}

export interface ResearchResult {
  query: string;
  brief: string;
  sub_questions: string[];
  sources: CitedSource[];
  markdown: string;
  assessments: AssessmentRecord[];
  rounds: number;
  attempts: number;
  pass_rate_history: number[];
  verifications: ClaimVerification[];
  verification_summary: VerificationSummary;
}

export type ResearchEvent =
  | { type: "brief"; brief: string; sub_questions: string[] }
  | { type: "round_started"; round: number; queries: string[] }
  | { type: "searching"; round: number; index: number; query: string }
  | { type: "search_results"; round: number; index: number; count: number }
  | { type: "search_failed"; round: number; index: number; error: string }
  | { type: "fetching"; url: string; position: number; total: number }
  | {
      type: "summarized";
      url: string;
      n: number;
      summary: string;
      position: number;
      total: number;
    }
  | { type: "source_skipped"; url: string; reason: string }
  | { type: "source_error"; url: string; error: string }
  | { type: "assessing"; round: number; sources_count: number }
  | { type: "assessment"; record: AssessmentRecord }
  | {
      type: "writing";
      attempt: number;
      sources_count: number;
      unsupported_count: number;
    }
  | { type: "written"; attempt: number; markdown_chars: number }
  | { type: "verifying"; total: number }
  | {
      type: "verified_claim";
      source_n: number;
      supported: boolean;
      reason: string;
      done: number;
      total: number;
    }
  | {
      type: "verify_failed";
      attempt: number;
      pass_rate: number;
      threshold: number;
      retrying: boolean;
    }
  | { type: "completed"; result: ResearchResult };

export interface ResearchOptions {
  query: string;
  anthropicApiKey: string;
  steelApiKey: string;
  steelBaseUrl?: string;
  maxSubQuestions?: number;
  maxResultsPerQuestion?: number;
  maxSources?: number;
  maxHops?: number;
  verifyThreshold?: number;
  engine?: Engine;
  useProxy?: boolean;
  fastModel?: string;
  writerModel?: string;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

function urlDomain(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey,
    steelApiKey,
    steelBaseUrl,
    maxSubQuestions = 4,
    maxResultsPerQuestion = 5,
    maxSources = 12,
    maxHops = 2,
    verifyThreshold = 0.7,
    engine = "ddg",
    useProxy = false,
    fastModel,
    writerModel,
    onEvent,
    signal,
  } = opts;

  if (!query || !query.trim()) {
    throw new Error("research: query is required");
  }
  if (!anthropicApiKey) {
    throw new Error("research: anthropicApiKey is required");
  }
  if (!steelApiKey) {
    throw new Error("research: steelApiKey is required");
  }

  const emit = (e: ResearchEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // user callbacks must never break the pipeline
    }
  };
  const abort = () => signal?.throwIfAborted();

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
  const steel = createSteel({ apiKey: steelApiKey, baseUrl: steelBaseUrl });

  // ---- phase 1: brief ----
  abort();
  const plan = await planBriefAndSubQuestions({
    anthropic,
    query,
    max_sub_questions: maxSubQuestions,
    model: fastModel,
  });
  emit({ type: "brief", brief: plan.brief, sub_questions: plan.sub_questions });

  // ---- phases 2/3/4: search → fetch → assess (looped per hop) ----
  let round = 1;
  let currentQueries =
    plan.sub_questions.length > 0 ? plan.sub_questions : [query];
  const sources: CitedSource[] = [];
  const sourceUrls = new Set<string>();
  const assessments: AssessmentRecord[] = [];

  while (true) {
    abort();

    if (currentQueries.length > 0) {
      emit({ type: "round_started", round, queries: currentQueries });

      const perQ = await Promise.all(
        currentQueries.map(async (q, idx) => {
          emit({ type: "searching", round, index: idx, query: q });
          const outcome = await webSearch({
            steel,
            query: q,
            engine,
            useProxy,
            limit: maxResultsPerQuestion,
          });
          if (!outcome.ok) {
            emit({
              type: "search_failed",
              round,
              index: idx,
              error: outcome.error.message,
            });
            return [] as Array<SearchResult & { sub_question_idx: number }>;
          }
          emit({
            type: "search_results",
            round,
            index: idx,
            count: outcome.results.length,
          });
          return outcome.results.map((r) => ({ ...r, sub_question_idx: idx }));
        }),
      );

      abort();

      const flat = perQ.flat();
      const byUrl = new Map<string, (typeof flat)[number]>();
      for (const r of flat) {
        if (sourceUrls.has(r.url)) continue;
        if (!byUrl.has(r.url)) byUrl.set(r.url, r);
      }

      const byDomain = new Map<string, number>();
      for (const s of sources) {
        const d = urlDomain(s.url);
        if (d) byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
      }

      const remaining = Math.max(0, maxSources - sources.length);
      const queue: Array<{ url: string; title: string; sub_question: string }> =
        [];
      for (const r of byUrl.values()) {
        if (queue.length >= remaining) break;
        const dCount = byDomain.get(r.domain) ?? 0;
        if (dCount >= PER_DOMAIN_CAP) continue;
        byDomain.set(r.domain, dCount + 1);
        queue.push({
          url: r.url,
          title: r.title,
          sub_question: currentQueries[r.sub_question_idx] ?? "",
        });
      }

      for (let i = 0; i < queue.length; i++) {
        abort();
        const item = queue[i];
        try {
          emit({
            type: "fetching",
            url: item.url,
            position: i + 1,
            total: queue.length,
          });
          const scrape = await steel.scrape({
            url: item.url,
            format: ["markdown"],
            useProxy,
          });
          const markdown = scrape.content?.markdown ?? "";
          const title = scrape.metadata?.title ?? item.title;
          if (!markdown) throw new Error("Empty markdown from Steel");

          abort();
          const summary = await summarizeWebpage({
            anthropic,
            markdown,
            url: item.url,
            title,
            sub_question: item.sub_question,
            model: fastModel,
          });

          if (summary.is_relevant && summary.summary) {
            const n = sources.length + 1;
            const src: CitedSource = {
              n,
              url: item.url,
              title,
              summary: summary.summary,
              key_excerpts: summary.key_excerpts,
            };
            sources.push(src);
            sourceUrls.add(item.url);
            emit({
              type: "summarized",
              url: item.url,
              n,
              summary: summary.summary,
              position: i + 1,
              total: queue.length,
            });
          } else {
            emit({
              type: "source_skipped",
              url: item.url,
              reason: "not relevant",
            });
          }
        } catch (err) {
          abort();
          const message = err instanceof Error ? err.message : String(err);
          emit({ type: "source_error", url: item.url, error: message });
        }
      }
    }

    // ---- assess ----
    abort();

    const hopsUsed = round - 1;
    const reachedHopCap = hopsUsed >= maxHops;
    const reachedSourceCap = sources.length >= maxSources;

    if (maxHops === 0 || reachedHopCap || reachedSourceCap) {
      const reason = reachedSourceCap
        ? "source cap reached"
        : reachedHopCap
          ? "hop cap reached"
          : "single-round mode";
      const rec: AssessmentRecord = {
        round,
        sufficient: true,
        gaps: [],
        additional_queries: [],
        reason,
      };
      assessments.push(rec);
      emit({ type: "assessment", record: rec });
      break;
    }

    emit({ type: "assessing", round, sources_count: sources.length });

    let goingDeeper = false;
    let assessmentRec: AssessmentRecord;
    try {
      const assessment = await assessCoverage({
        anthropic,
        brief: plan.brief,
        sub_questions: plan.sub_questions,
        sources,
        rounds_remaining: maxHops - hopsUsed,
        max_additional_queries: MAX_ADDITIONAL_QUERIES,
        model: fastModel,
      });

      goingDeeper =
        !assessment.sufficient && assessment.additional_queries.length > 0;
      assessmentRec = {
        round,
        sufficient: !goingDeeper,
        gaps: assessment.gaps,
        additional_queries: assessment.additional_queries,
      };
    } catch (err) {
      abort();
      assessmentRec = {
        round,
        sufficient: true,
        gaps: [],
        additional_queries: [],
        reason: `assessment failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    assessments.push(assessmentRec);
    emit({ type: "assessment", record: assessmentRec });

    if (!goingDeeper) break;
    currentQueries = assessmentRec.additional_queries;
    round += 1;
  }

  // ---- phases 5/6: write + verify (one retry on verify fail) ----
  let attempt = 1;
  let markdown = "";
  let verifications: ClaimVerification[] = [];
  const passRateHistory: number[] = [];

  while (true) {
    abort();

    const unsupported: UnsupportedClaim[] | undefined =
      attempt > 1
        ? verifications
            .filter((v) => !v.supported)
            .map((v) => ({
              claim: v.claim,
              source_n: v.source_n,
              reason: v.reason,
            }))
        : undefined;

    emit({
      type: "writing",
      attempt,
      sources_count: sources.length,
      unsupported_count: unsupported?.length ?? 0,
    });
    const report = await writeReport({
      anthropic,
      brief: plan.brief || query,
      sources,
      unsupported_claims: unsupported,
      model: writerModel,
    });
    markdown = report.markdown;
    emit({ type: "written", attempt, markdown_chars: markdown.length });

    abort();

    const claims: ParsedClaim[] = parseCitations(markdown);
    verifications = [];

    emit({ type: "verifying", total: claims.length });

    if (claims.length > 0) {
      const sourcesByN = new Map(sources.map((s) => [s.n, s] as const));
      for (let i = 0; i < claims.length; i += VERIFY_BATCH) {
        abort();
        const batch = claims.slice(i, i + VERIFY_BATCH);
        const verdicts = await Promise.all(
          batch.map(async (claim): Promise<ClaimVerification> => {
            const src = sourcesByN.get(claim.source_n);
            if (!src) {
              return {
                claim: claim.text,
                source_n: claim.source_n,
                source_url: null,
                source_title: null,
                supported: false,
                reason: `Source [${claim.source_n}] not found in source list`,
              };
            }
            try {
              const v = await verifyClaim({
                anthropic,
                claim: claim.text,
                source: src,
                model: fastModel,
              });
              return {
                claim: claim.text,
                source_n: claim.source_n,
                source_url: src.url,
                source_title: src.title,
                supported: v.supported,
                reason: v.reason,
              };
            } catch (err) {
              const message =
                err instanceof Error ? err.message : String(err);
              return {
                claim: claim.text,
                source_n: claim.source_n,
                source_url: src.url,
                source_title: src.title,
                supported: false,
                reason: `verify error: ${message}`,
              };
            }
          }),
        );

        verifications.push(...verdicts);
        for (const v of verdicts) {
          emit({
            type: "verified_claim",
            source_n: v.source_n,
            supported: v.supported,
            reason: v.reason,
            done: verifications.length,
            total: claims.length,
          });
        }
      }
    }

    const total = verifications.length;
    const supported = verifications.filter((v) => v.supported).length;
    const passRate = total > 0 ? supported / total : 1;
    passRateHistory.push(passRate);

    const shouldRetry =
      passRate < verifyThreshold &&
      attempt < MAX_WRITE_ATTEMPTS &&
      total > 0;

    if (shouldRetry) {
      emit({
        type: "verify_failed",
        attempt,
        pass_rate: passRate,
        threshold: verifyThreshold,
        retrying: true,
      });
      attempt += 1;
      continue;
    }

    break;
  }

  const totalClaims = verifications.length;
  const supportedClaims = verifications.filter((v) => v.supported).length;
  const passRate = totalClaims > 0 ? supportedClaims / totalClaims : 1;

  const result: ResearchResult = {
    query,
    brief: plan.brief,
    sub_questions: plan.sub_questions,
    sources,
    markdown,
    assessments,
    rounds: round,
    attempts: attempt,
    pass_rate_history: passRateHistory,
    verifications,
    verification_summary: {
      total: totalClaims,
      supported: supportedClaims,
      unsupported: totalClaims - supportedClaims,
      pass_rate: passRate,
    },
  };

  emit({ type: "completed", result });
  return result;
}
