import Anthropic from "@anthropic-ai/sdk";
import {
  assessCoverage,
  critiqueDraft,
  expandQueries,
  parseCitations,
  planBriefAndSubQuestions,
  summarizeWebpage,
  verifyClaim,
  writeReport,
  type CitedSource,
  type CritiqueResult,
  type ParsedClaim,
  type QueryExpansion,
  type UnsupportedClaim,
} from "./pipeline.js";
import { webSearch, type Engine, type SearchResult } from "./search.js";
import { createSteel } from "./steel.js";

const MAX_WRITE_ATTEMPTS = 2;
const VERIFY_BATCH = 3;
const PER_DOMAIN_CAP = 2;
const MAX_ADDITIONAL_QUERIES = 3;
const DEFAULT_FETCH_CONCURRENCY = 5;
const STORED_MARKDOWN_CAP = 50_000;

export type {
  CitedSource,
  CritiqueResult,
  ParsedClaim,
  QueryExpansion,
  UnsupportedClaim,
} from "./pipeline.js";
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

export interface AgentRun {
  sub_question: string;
  expanded_queries: string[];
  source_ns: number[];
  rounds: number;
  assessments: AssessmentRecord[];
}

export interface ResearchResult {
  query: string;
  brief: string;
  sub_questions: string[];
  agent_runs: AgentRun[];
  sources: CitedSource[];
  markdown: string;
  critiques: CritiqueResult[];
  attempts: number;
  pass_rate_history: number[];
  verifications: ClaimVerification[];
  verification_summary: VerificationSummary;
}

export type ResearchEvent =
  | { type: "brief"; brief: string; sub_questions: string[] }
  | { type: "expanded_queries"; expansions: QueryExpansion[] }
  | {
      type: "agent_started";
      sub_question: string;
      expanded_queries: string[];
    }
  | {
      type: "round_started";
      sub_question: string;
      round: number;
      queries: string[];
    }
  | {
      type: "searching";
      sub_question: string;
      round: number;
      index: number;
      query: string;
    }
  | {
      type: "search_results";
      sub_question: string;
      round: number;
      index: number;
      count: number;
    }
  | {
      type: "search_failed";
      sub_question: string;
      round: number;
      index: number;
      error: string;
    }
  | {
      type: "fetching";
      sub_question: string;
      url: string;
      position: number;
      total: number;
    }
  | {
      type: "summarized";
      sub_question: string;
      url: string;
      n: number;
      summary: string;
      position: number;
      total: number;
    }
  | {
      type: "source_skipped";
      sub_question: string;
      url: string;
      reason: string;
    }
  | {
      type: "source_error";
      sub_question: string;
      url: string;
      error: string;
    }
  | {
      type: "assessing";
      sub_question: string;
      round: number;
      sources_count: number;
    }
  | {
      type: "assessment";
      sub_question: string;
      record: AssessmentRecord;
    }
  | {
      type: "agent_finished";
      sub_question: string;
      sources_added: number;
      rounds: number;
    }
  | {
      type: "writing";
      attempt: number;
      sources_count: number;
      unsupported_count: number;
    }
  | { type: "written"; attempt: number; markdown_chars: number }
  | { type: "critiquing"; attempt: number }
  | {
      type: "critique_done";
      attempt: number;
      needs_revision: boolean;
      issues: string[];
    }
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
  fetchConcurrency?: number;
  queriesPerSubq?: number;
  critique?: boolean;
  verifyThreshold?: number;
  engine?: Engine;
  useProxy?: boolean;
  fastModel?: string;
  writerModel?: string;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

async function pMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const n = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
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
    maxHops = 3,
    fetchConcurrency = DEFAULT_FETCH_CONCURRENCY,
    queriesPerSubq = 3,
    critique = true,
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

  // ---- phase 1b: query expansion ----
  abort();
  const baseSubQuestions =
    plan.sub_questions.length > 0 ? plan.sub_questions : [query];
  const expansions = await expandQueries({
    anthropic,
    brief: plan.brief || query,
    sub_questions: baseSubQuestions,
    queries_per_subq: queriesPerSubq,
    model: fastModel,
  });
  emit({ type: "expanded_queries", expansions });

  // ---- phases 2/3/4: per-sub-question agents (search → fetch → mini-assess) ----
  const sources: CitedSource[] = [];
  const sourceUrls = new Set<string>();
  const sourceMarkdowns = new Map<number, string>();
  const globalDomainCounts = new Map<string, number>();
  const critiques: CritiqueResult[] = [];

  // Per-agent budget: each agent gets a fair slice of the global source cap
  // (+1 slack) so they can compete without starving each other.
  const numAgents = Math.max(1, expansions.length);
  const agentSourceCap = Math.max(2, Math.ceil(maxSources / numAgents) + 1);
  const agentFetchConcurrency = Math.max(
    1,
    Math.ceil(fetchConcurrency / numAgents),
  );

  async function runSubAgent(exp: QueryExpansion): Promise<AgentRun> {
    const subQ = exp.sub_question;
    let queries = exp.queries.length > 0 ? exp.queries : [subQ];
    const myAddedNs: number[] = [];
    const myAssessments: AssessmentRecord[] = [];
    let round = 1;

    emit({
      type: "agent_started",
      sub_question: subQ,
      expanded_queries: queries,
    });

    while (true) {
      abort();

      emit({ type: "round_started", sub_question: subQ, round, queries });

      const perQ = await Promise.all(
        queries.map(async (q, idx) => {
          emit({
            type: "searching",
            sub_question: subQ,
            round,
            index: idx,
            query: q,
          });
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
              sub_question: subQ,
              round,
              index: idx,
              error: outcome.error.message,
            });
            return [] as SearchResult[];
          }
          emit({
            type: "search_results",
            sub_question: subQ,
            round,
            index: idx,
            count: outcome.results.length,
          });
          return outcome.results;
        }),
      );

      abort();

      // Dedupe against the global URL set so agents don't refetch what others
      // (or earlier rounds) already grabbed.
      const flat = perQ.flat();
      const byUrl = new Map<string, (typeof flat)[number]>();
      for (const r of flat) {
        if (sourceUrls.has(r.url)) continue;
        if (!byUrl.has(r.url)) byUrl.set(r.url, r);
      }

      const globalRemaining = Math.max(0, maxSources - sources.length);
      const agentRemaining = Math.max(0, agentSourceCap - myAddedNs.length);
      const cap = Math.min(globalRemaining, agentRemaining);

      const queue: Array<{ url: string; title: string }> = [];
      for (const r of byUrl.values()) {
        if (queue.length >= cap) break;
        const dCount = globalDomainCounts.get(r.domain) ?? 0;
        if (dCount >= PER_DOMAIN_CAP) continue;
        globalDomainCounts.set(r.domain, dCount + 1);
        queue.push({ url: r.url, title: r.title });
      }

      await pMap(queue, agentFetchConcurrency, async (item, i) => {
        abort();
        try {
          emit({
            type: "fetching",
            sub_question: subQ,
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
            sub_question: subQ,
            model: fastModel,
          });

          if (summary.is_relevant && summary.summary) {
            // JS event loop is single-threaded: this n-assign + push is atomic
            // between awaits, so parallel agents won't collide on n.
            const n = sources.length + 1;
            sources.push({
              n,
              url: item.url,
              title,
              summary: summary.summary,
              key_excerpts: summary.key_excerpts,
              sub_question: subQ,
            });
            sourceUrls.add(item.url);
            sourceMarkdowns.set(n, markdown.slice(0, STORED_MARKDOWN_CAP));
            myAddedNs.push(n);
            emit({
              type: "summarized",
              sub_question: subQ,
              url: item.url,
              n,
              summary: summary.summary,
              position: i + 1,
              total: queue.length,
            });
          } else {
            emit({
              type: "source_skipped",
              sub_question: subQ,
              url: item.url,
              reason: "not relevant",
            });
          }
        } catch (err) {
          abort();
          const message = err instanceof Error ? err.message : String(err);
          emit({
            type: "source_error",
            sub_question: subQ,
            url: item.url,
            error: message,
          });
        }
      });

      abort();

      const reachedAgentCap = myAddedNs.length >= agentSourceCap;
      const reachedGlobalCap = sources.length >= maxSources;
      const reachedHopCap = round >= maxHops;

      if (reachedAgentCap || reachedGlobalCap || reachedHopCap) {
        const reason = reachedAgentCap
          ? "agent source cap reached"
          : reachedGlobalCap
            ? "global source cap reached"
            : "hop cap reached";
        const rec: AssessmentRecord = {
          round,
          sufficient: true,
          gaps: [],
          additional_queries: [],
          reason,
        };
        myAssessments.push(rec);
        emit({ type: "assessment", sub_question: subQ, record: rec });
        break;
      }

      emit({
        type: "assessing",
        sub_question: subQ,
        round,
        sources_count: myAddedNs.length,
      });

      let goingDeeper = false;
      let assessmentRec: AssessmentRecord;
      try {
        const mySet = new Set(myAddedNs);
        const mySources = sources.filter((s) => mySet.has(s.n));
        const assessment = await assessCoverage({
          anthropic,
          brief: `Specifically cover this sub-question: ${subQ}. (Part of the wider brief: ${plan.brief || query})`,
          sub_questions: [subQ],
          sources: mySources,
          per_subq_coverage: [
            { sub_question: subQ, source_count: mySources.length },
          ],
          rounds_remaining: maxHops - round,
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

      myAssessments.push(assessmentRec);
      emit({ type: "assessment", sub_question: subQ, record: assessmentRec });

      if (!goingDeeper) break;
      queries = assessmentRec.additional_queries;
      round += 1;
    }

    emit({
      type: "agent_finished",
      sub_question: subQ,
      sources_added: myAddedNs.length,
      rounds: round,
    });

    return {
      sub_question: subQ,
      expanded_queries: exp.queries,
      source_ns: [...myAddedNs],
      rounds: round,
      assessments: myAssessments,
    };
  }

  const agentRuns = await Promise.all(expansions.map(runSubAgent));

  // ---- phases 5/6/7: write → critique → verify (one retry if either flags) ----
  let attempt = 1;
  let markdown = "";
  let verifications: ClaimVerification[] = [];
  let lastCritiqueIssues: string[] = [];
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
    const critiqueForRewrite =
      attempt > 1 && lastCritiqueIssues.length > 0
        ? lastCritiqueIssues
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
      source_texts: sourceMarkdowns,
      unsupported_claims: unsupported,
      critique_issues: critiqueForRewrite,
      model: writerModel,
    });
    markdown = report.markdown;
    emit({ type: "written", attempt, markdown_chars: markdown.length });

    abort();

    // ---- critique ----
    let critiqueResult: CritiqueResult = { needs_revision: false, issues: [] };
    if (critique) {
      emit({ type: "critiquing", attempt });
      try {
        critiqueResult = await critiqueDraft({
          anthropic,
          brief: plan.brief || query,
          sub_questions: plan.sub_questions,
          markdown,
          sources,
          model: writerModel,
        });
      } catch (err) {
        abort();
        // critique failure should NOT fail the whole research
        critiqueResult = {
          needs_revision: false,
          issues: [
            `critique error: ${err instanceof Error ? err.message : String(err)}`,
          ],
        };
      }
      emit({
        type: "critique_done",
        attempt,
        needs_revision: critiqueResult.needs_revision,
        issues: critiqueResult.issues,
      });
    }
    critiques.push(critiqueResult);
    lastCritiqueIssues = critiqueResult.needs_revision
      ? critiqueResult.issues
      : [];

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

    const verifyFailed = total > 0 && passRate < verifyThreshold;
    const critiqueFailed = critique && critiqueResult.needs_revision;
    const shouldRetry =
      (verifyFailed || critiqueFailed) && attempt < MAX_WRITE_ATTEMPTS;

    if (shouldRetry) {
      if (verifyFailed) {
        emit({
          type: "verify_failed",
          attempt,
          pass_rate: passRate,
          threshold: verifyThreshold,
          retrying: true,
        });
      }
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
    agent_runs: agentRuns,
    sources,
    markdown,
    critiques,
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
