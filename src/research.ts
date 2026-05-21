import Anthropic from "@anthropic-ai/sdk";
import {
  assembleSectionedReport,
  critiqueDraft,
  parseCitations,
  planBriefAndSubQuestions,
  planOutline,
  verifyClaim,
  writeReport,
  writeSection,
  type CitedSource,
  type CritiqueResult,
  type ParsedClaim,
  type UnsupportedClaim,
} from "./pipeline.js";
import { type Engine } from "./search.js";
import { createSteel } from "./steel.js";
import { runAgenticSubAgent, type AgentContext } from "./tools.js";

const MAX_WRITE_ATTEMPTS = 2;
const VERIFY_BATCH = 3;
const PER_DOMAIN_CAP = 2;

export type {
  CitedSource,
  CritiqueResult,
  ParsedClaim,
  UnsupportedClaim,
} from "./pipeline.js";
export type { Engine } from "./search.js";

export interface ClaimVerification {
  claim: string;
  source_n: number;
  source_url: string | null;
  source_title: string | null;
  supported: boolean;
  reason: string;
}

export interface VerificationSummary {
  total: number;
  supported: number;
  unsupported: number;
  pass_rate: number;
}

export interface AgentRun {
  sub_question: string;
  source_ns: number[];
  tool_calls: number;
  finish_reason: string;
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
  | { type: "agent_started"; sub_question: string }
  | { type: "searching"; sub_question: string; index: number; query: string }
  | {
      type: "search_results";
      sub_question: string;
      index: number;
      count: number;
    }
  | {
      type: "search_failed";
      sub_question: string;
      index: number;
      error: string;
    }
  | { type: "fetching"; sub_question: string; url: string }
  | {
      type: "summarized";
      sub_question: string;
      url: string;
      n: number;
      summary: string;
    }
  | {
      type: "source_skipped";
      sub_question: string;
      url: string;
      reason: string;
    }
  | { type: "source_error"; sub_question: string; url: string; error: string }
  | { type: "agent_finished"; sub_question: string; sources_added: number }
  | { type: "outlining"; attempt: number }
  | {
      type: "outline_done";
      attempt: number;
      sections: Array<{ title: string; source_ns: number[] }>;
    }
  | {
      type: "section_writing";
      attempt: number;
      index: number;
      total: number;
      title: string;
    }
  | {
      type: "section_written";
      attempt: number;
      index: number;
      total: number;
      title: string;
      markdown_chars: number;
    }
  | {
      type: "section_failed";
      attempt: number;
      index: number;
      total: number;
      title: string;
      error: string;
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
  maxSources?: number;
  critique?: boolean;
  verifyThreshold?: number;
  /** Default backend for the web search tool. */
  engine?: Engine;
  useProxy?: boolean;
  fastModel?: string;
  writerModel?: string;
  /** Per-sub-agent cap on tool calls (search / fetch / finish). Default 12. */
  maxToolCalls?: number;
  /** Optional GitHub token used by the github search backend (raises rate
   *  limit). */
  githubToken?: string;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey,
    steelApiKey,
    steelBaseUrl,
    maxSubQuestions = 4,
    maxSources = 12,
    critique = true,
    verifyThreshold = 0.7,
    engine = "ddg",
    useProxy = false,
    fastModel,
    writerModel,
    maxToolCalls,
    githubToken,
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

  // Bump SDK retries above the default 2. The SDK already retries 408/409/429
  // and 5xx with exp backoff + retry-after, so this transparently absorbs
  // most concurrent-connection bursts. 5 retries → ~1–2 min worst case.
  const anthropic = new Anthropic({ apiKey: anthropicApiKey, maxRetries: 5 });
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

  const subQuestions =
    plan.sub_questions.length > 0 ? plan.sub_questions : [query];

  // ---- phase 2: per-sub-question agents (parallel) ----
  const sources: CitedSource[] = [];
  const sourceUrls = new Set<string>();
  const sourceMarkdowns = new Map<number, string>();
  const globalDomainCounts = new Map<string, number>();
  const critiques: CritiqueResult[] = [];

  // Each agent gets a fair slice of the global source cap (+1 slack) so they
  // can compete without starving each other.
  const numAgents = Math.max(1, subQuestions.length);
  const agentSourceCap = Math.max(2, Math.ceil(maxSources / numAgents) + 1);

  // Shared context. All parallel agents alias the same sources / sourceUrls /
  // sourceMarkdowns / globalDomainCounts, so commits from one are visible to
  // the others (URL dedup, per-domain cap, global cap).
  const ctx: AgentContext = {
    anthropic,
    steel,
    sources,
    sourceUrls,
    sourceMarkdowns,
    globalDomainCounts,
    emit,
    abort,
    defaultEngine: engine,
    useProxy,
    fastModel,
    perDomainCap: PER_DOMAIN_CAP,
    globalSourceCap: maxSources,
    githubToken,
  };

  const agentRuns = await Promise.all(
    subQuestions.map(async (sub_question): Promise<AgentRun> => {
      const result = await runAgenticSubAgent({
        ctx,
        brief: plan.brief || query,
        sub_question,
        agent_source_cap: agentSourceCap,
        max_tool_calls: maxToolCalls,
      });
      return {
        sub_question,
        source_ns: result.source_ns,
        tool_calls: result.tool_calls,
        finish_reason: result.finish_reason,
      };
    }),
  );

  // ---- phases 3/4/5: write → critique → verify (one retry if either flags) ----
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

    // First attempt: outline → per-section parallel writes → assemble. Each
    // section sees ONLY its own sources at full raw fidelity, so the writer
    // doesn't have to do internal retrieval over a huge context.
    // Retry attempts: single-pass writer with critique + unsupported-claim
    // feedback fed in. Surgical rewrites are cleaner than re-planning.
    if (attempt === 1 && sources.length > 0) {
      try {
        emit({ type: "outlining", attempt });
        const outline = await planOutline({
          anthropic,
          brief: plan.brief || query,
          sub_questions: plan.sub_questions,
          sources,
          model: writerModel,
        });

        if (outline.sections.length === 0) {
          throw new Error("outline returned no sections");
        }

        emit({
          type: "outline_done",
          attempt,
          sections: outline.sections.map((s) => ({
            title: s.title,
            source_ns: s.source_ns,
          })),
        });

        const sectionTotal = outline.sections.length;
        const sourcesByN = new Map(sources.map((s) => [s.n, s] as const));

        const sectionResults = await Promise.all(
          outline.sections.map(async (section, idx): Promise<string | null> => {
            abort();
            const sources_for_section = section.source_ns
              .map((n) => sourcesByN.get(n))
              .filter((s): s is CitedSource => s !== undefined);
            const priorTitles = outline.sections
              .slice(0, idx)
              .map((s) => s.title);
            const upcomingTitles = outline.sections
              .slice(idx + 1)
              .map((s) => s.title);
            emit({
              type: "section_writing",
              attempt,
              index: idx + 1,
              total: sectionTotal,
              title: section.title,
            });
            try {
              const { markdown: sectionMd } = await writeSection({
                anthropic,
                brief: plan.brief || query,
                section,
                section_index: idx + 1,
                section_total: sectionTotal,
                prior_section_titles: priorTitles,
                upcoming_section_titles: upcomingTitles,
                sources_for_section,
                source_texts: sourceMarkdowns,
                model: writerModel,
              });
              emit({
                type: "section_written",
                attempt,
                index: idx + 1,
                total: sectionTotal,
                title: section.title,
                markdown_chars: sectionMd.length,
              });
              return sectionMd;
            } catch (err) {
              // Per-section failure (typically API rate limit after SDK retries
              // gave up). Drop just this section — keep the others. AbortError
              // still propagates so Ctrl+C kills the run cleanly.
              if ((err as { name?: string })?.name === "AbortError") throw err;
              emit({
                type: "section_failed",
                attempt,
                index: idx + 1,
                total: sectionTotal,
                title: section.title,
                error: err instanceof Error ? err.message : String(err),
              });
              return null;
            }
          }),
        );

        const goodSections = sectionResults.filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        );
        if (goodSections.length === 0) {
          throw new Error("all sections failed");
        }
        markdown = assembleSectionedReport(sources, goodSections);
      } catch (err) {
        abort();
        // Outline / section write failure → fall back to single-pass writer.
        // The pipeline must still produce a report; sectioning is an
        // optimization, not a hard requirement.
        const report = await writeReport({
          anthropic,
          brief: plan.brief || query,
          sources,
          source_texts: sourceMarkdowns,
          model: writerModel,
        });
        markdown = report.markdown;
      }
    } else {
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
    }

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
                raw_text: sourceMarkdowns.get(claim.source_n),
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
