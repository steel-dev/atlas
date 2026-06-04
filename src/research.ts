import type {
  LanguageModel,
  ModelProvider,
  ProviderOptions,
  UsageSummary,
} from "./model.js";
import type { FetchedSource, SourceDocument, CitedSource } from "./sources.js";
import {
  resolveSearchProvider,
  type SearchProvider,
} from "./search-provider.js";
import type { BrowserProvider } from "./steel.js";
import { runGapLoop } from "./research-loop.js";
import { runRecall, type RecallOutcome } from "./recall.js";
import {
  verifyClaims,
  type VerifierPanelMode,
  type VerifySummary,
} from "./verify.js";
import {
  fallbackReportFromClaims,
  inconclusiveReport,
  synthesizeReportData,
  writeReportProse,
} from "./synthesize.js";
import type { ResearchClaim } from "./claims.js";
import { createClaimLedger } from "./claims.js";
import {
  resolveRunConfig,
  createRunResources,
  type ResolvedRunConfig,
  type RunResources,
} from "./config-resolution.js";
import {
  createAgentScope,
  createSourceStore,
  createConcurrencyGate,
  type ResearchCtx,
  type ResearchLoopEvent,
} from "./runtime.js";
import { normalizeUrlForSource } from "./url.js";
import { createResearchStreamController } from "./research-stream.js";

export type {
  LanguageModel,
  ModelProvider,
  ProviderOptions,
  UsageSummary,
} from "./model.js";
export type { FetchedSource, SourceDocument, CitedSource } from "./sources.js";
export type { VerifierPanelMode } from "./verify.js";
export type {
  ClaimConfidence,
  ClaimImportance,
  ClaimSourceQuality,
  ClaimStatus,
  ClaimVote,
  ResearchClaim,
} from "./claims.js";

export interface ResearchClaims {
  confirmed: ResearchClaim[];
  refuted: ResearchClaim[];
  unverified: ResearchClaim[];
}

export interface ResearchStats {
  angles: number;
  sourcesFetched: number;
  claimsExtracted: number;
  claimsUnsupported: number;
  claimsVerified: number;
  confirmed: number;
  refuted: number;
  unverified: number;
  beyondVerifyCap: number;
  clustersFormed: number;
  claimsDeduped: number;
  recallUrlDupes: number;
  recallBudgetDropped: number;
  recallSpamDropped: number;
  recallLowRelevanceDropped: number;
  leadToolCalls: number;
  surveys: number;
  reanchors: number;
}

export interface ResearchResult {
  query: string;
  provider: ModelProvider;
  model: string;
  markdown: string;
  openQuestions: string[];
  caveats: string[];
  claims: ResearchClaims;
  stats: ResearchStats;
  citedSources: CitedSource[];
  citationsNotConfirmed: string[];
  citationsNotFetched: string[];
  finishReason: string;
  sourceDocuments?: SourceDocument[];
  usage: UsageSummary;
}

type LeadResearchEvent =
  | { type: "citations_not_fetched"; count: number; urls: string[] }
  | { type: "written"; markdownChars: number }
  | { type: "completed"; result: ResearchResult };

export type ResearchEvent = ResearchLoopEvent | LeadResearchEvent;

export type ResearchEventType = ResearchEvent["type"];

export type ResearchEventMap = {
  [E in ResearchEvent as E["type"]]: E;
};

export type ResearchEventListener<K extends ResearchEventType> = (
  event: ResearchEventMap[K],
) => void;

export type ResearchDepth = "quick" | "standard" | "deep";

export interface RunOptions {
  timeoutMs?: number;
  tokenLimit?: number;
  depth?: ResearchDepth;
  signal?: AbortSignal;
  exploreProviderOptions?: ProviderOptions;
  finalizeProviderOptions?: ProviderOptions;
  includeSourceDocuments?: boolean;
  verifierPanel?: VerifierPanelMode;
}

export interface ResearchOptions extends RunOptions {
  query: string;
  model: Exclude<LanguageModel, string>;
  leafModel?: Exclude<LanguageModel, string>;
  browser?: BrowserProvider;
  search?: SearchProvider;
  instructions?: string;
}

export interface QueryOptions extends RunOptions {
  query: string;
}

export type RunInput = ResearchOptions;

export interface ResearchStream {
  readonly fullStream: AsyncIterable<ResearchEvent>;
  readonly textStream: AsyncIterable<string>;
  readonly events: AsyncIterable<ResearchEvent>;
  readonly result: Promise<ResearchResult>;
  readonly markdown: Promise<string>;
  readonly citedSources: Promise<CitedSource[]>;
  readonly citationsNotFetched: Promise<string[]>;
  readonly usage: Promise<UsageSummary>;
  on<K extends ResearchEventType>(
    type: K,
    listener: ResearchEventListener<K>,
  ): () => void;
  once<K extends ResearchEventType>(
    type: K,
    listener: ResearchEventListener<K>,
  ): () => void;
  off<K extends ResearchEventType>(
    type: K,
    listener: ResearchEventListener<K>,
  ): void;
  abort(): void;
  stop(): void;
}

export function startResearchStream(input: RunInput): ResearchStream {
  if (!input.query?.trim()) {
    throw new Error("research: query is required");
  }
  if (!input.model) {
    throw new Error(
      'research: model is required (pass an AI SDK LanguageModel, e.g. openai("gpt-5.5"))',
    );
  }
  const hardController = new AbortController();
  const softController = new AbortController();
  const controller = createResearchStreamController();
  const externalSignal = input.signal;
  const onExternalAbort = () => hardController.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) hardController.abort(externalSignal.reason);
    else
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  queueMicrotask(() => {
    void runResearch(input, controller.emit, hardController, softController)
      .then(controller.resolve, controller.reject)
      .finally(() => {
        externalSignal?.removeEventListener("abort", onExternalAbort);
        controller.close();
      });
  });
  return controller.build({
    abort: () => hardController.abort(),
    stop: () => softController.abort(),
  });
}

async function runResearch(
  opts: RunInput,
  emit: (event: ResearchEvent) => void,
  hardController: AbortController,
  softController: AbortController,
): Promise<ResearchResult> {
  const config = resolveRunConfig(opts);
  const runSignal = combineSignals(hardController.signal, opts.timeoutMs);
  const throwIfAborted = () => runSignal?.throwIfAborted();
  const resources = createRunResources(opts, config, runSignal, emit);

  try {
    await using leadScope = createAgentScope({
      sink: emit,
      query: opts.query,
      deadlineAt: config.timeoutDeadlineAt,
      synthesisReserveMs: config.synthesisReserveMs,
    });
    const ctx = buildResearchCtx({
      config,
      resources,
      leadScope,
      runSignal,
      stopSignal: softController.signal,
      throwIfAborted,
    });

    ctx.scope.emit({ type: "research_started" });
    const recall = await runRecall(ctx, opts.query);
    const loop = await runGapLoop({
      ctx,
      question: opts.query,
      recall,
      maxToolCalls: config.safetyMaxToolCalls,
    });
    await ctx.store.claims.settle();

    throwIfAborted();
    const verify = await verifyClaims(ctx, opts.query);
    const claims = partitionClaims(ctx);
    const candidates = selectCandidates(claims.unverified);
    ctx.scope.emit({
      type: "research_finished",
      sourcesFetched: ctx.store.fetchedSources.length,
    });

    throwIfAborted();
    const report = await buildReport(
      ctx,
      opts.query,
      claims,
      candidates,
      verify,
      loop.gapsNote,
    );
    const markdown = report.markdown;

    const citations = reconcileCitations(
      markdown,
      ctx.store.fetchedSources,
      [...claims.confirmed, ...candidates],
    );
    if (citations.citationsNotFetched.length > 0) {
      emit({
        type: "citations_not_fetched",
        count: citations.citationsNotFetched.length,
        urls: citations.citationsNotFetched,
      });
    }
    emit({ type: "written", markdownChars: markdown.length });

    const result: ResearchResult = {
      query: opts.query,
      provider: config.provider,
      model: config.model,
      markdown,
      openQuestions: report.openQuestions,
      caveats: report.caveats,
      claims,
      stats: buildStats(ctx, recall, verify, loop),
      citedSources: citations.citedSources,
      citationsNotConfirmed: citations.citationsNotConfirmed,
      citationsNotFetched: citations.citationsNotFetched,
      finishReason: loop.finishReason,
      ...(opts.includeSourceDocuments
        ? { sourceDocuments: [...ctx.store.sourceDocuments.values()] }
        : {}),
      usage:
        resources.leafAdapter === resources.modelAdapter
          ? { ...resources.modelAdapter.usage }
          : sumUsage(
              resources.modelAdapter.usage,
              resources.leafAdapter.usage,
            ),
    };

    emit({ type: "completed", result });
    return result;
  } finally {
    await resources.browserSessionPool.closeAll();
  }
}

function partitionClaims(ctx: ResearchCtx): ResearchClaims {
  const all = ctx.store.claims.claims;
  return {
    confirmed: all.filter((claim) => claim.status === "confirmed"),
    refuted: all.filter((claim) => claim.status === "refuted"),
    unverified: all.filter(
      (claim) => claim.status === "unverified" || claim.status === "quoted",
    ),
  };
}

interface BuiltReport {
  markdown: string;
  caveats: string[];
  openQuestions: string[];
}

const CANDIDATE_IMPORTANCE_RANK = {
  central: 0,
  supporting: 1,
  tangential: 2,
} as const;
const CANDIDATE_QUALITY_RANK = {
  primary: 0,
  secondary: 1,
  blog: 2,
  forum: 3,
  unreliable: 4,
} as const;
const MAX_REPORT_CANDIDATES = 15;

function selectCandidates(unverified: ResearchClaim[]): ResearchClaim[] {
  return unverified
    .filter((claim) => !claim.duplicateOf)
    .slice()
    .sort(
      (a, b) =>
        CANDIDATE_IMPORTANCE_RANK[a.importance] -
          CANDIDATE_IMPORTANCE_RANK[b.importance] ||
        CANDIDATE_QUALITY_RANK[a.sourceQuality] -
          CANDIDATE_QUALITY_RANK[b.sourceQuality],
    )
    .slice(0, MAX_REPORT_CANDIDATES);
}

async function buildReport(
  ctx: ResearchCtx,
  question: string,
  claims: ResearchClaims,
  candidates: ResearchClaim[],
  verify: VerifySummary,
  gapsNote: string,
): Promise<BuiltReport> {
  const confirmed = claims.confirmed.filter((claim) => !claim.duplicateOf);
  const refuted = claims.refuted.filter((claim) => !claim.duplicateOf);
  const inconclusive = (): BuiltReport => ({
    markdown: inconclusiveReport({
      question,
      verify,
      refuted,
      sourcesFetched: ctx.store.fetchedSources.length,
      claimsUnsupported: ctx.store.claims.unsupportedCount,
      gapsNote,
    }),
    caveats: [],
    openQuestions: [],
  });
  if (confirmed.length === 0 && candidates.length === 0) {
    return inconclusive();
  }
  try {
    const data = await synthesizeReportData(ctx, {
      question,
      confirmed,
      candidates,
      refuted,
      ...(gapsNote ? { gapsNote } : {}),
    });
    if (data) {
      const markdown = await writeReportProse(ctx, { question, data });
      if (markdown) {
        return {
          markdown,
          caveats: data.caveats,
          openQuestions: data.openQuestions,
        };
      }
    }
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
  }
  return confirmed.length > 0
    ? {
        markdown: fallbackReportFromClaims(question, confirmed),
        caveats: [],
        openQuestions: [],
      }
    : inconclusive();
}

function buildStats(
  ctx: ResearchCtx,
  recall: RecallOutcome,
  verify: VerifySummary,
  loop: {
    toolCalls: number;
    surveys: number;
    reanchors: number;
  },
): ResearchStats {
  return {
    angles: recall.angles.length,
    sourcesFetched: ctx.store.fetchedSources.length,
    claimsExtracted: ctx.store.claims.claims.length,
    claimsUnsupported: ctx.store.claims.unsupportedCount,
    claimsVerified: verify.verified,
    confirmed: verify.confirmed,
    refuted: verify.refuted,
    unverified: verify.unverified,
    beyondVerifyCap: verify.beyondCap,
    clustersFormed: verify.clustersFormed,
    claimsDeduped: verify.claimsDeduped,
    recallUrlDupes: recall.urlDupes,
    recallBudgetDropped: recall.budgetDropped,
    recallSpamDropped: recall.spamDropped,
    recallLowRelevanceDropped: recall.lowRelevanceDropped,
    leadToolCalls: loop.toolCalls,
    surveys: loop.surveys,
    reanchors: loop.reanchors,
  };
}

// Assembles the per-run context (config/deps/store/scope) and wires the search
// provider, which needs the context it lives in.
function buildResearchCtx(args: {
  config: ResolvedRunConfig;
  resources: RunResources;
  leadScope: ResearchCtx["scope"];
  runSignal: AbortSignal | undefined;
  stopSignal: AbortSignal | undefined;
  throwIfAborted: () => void;
}): ResearchCtx {
  const { config, resources, leadScope, runSignal, stopSignal, throwIfAborted } =
    args;
  const ctx: ResearchCtx = {
    config: config.agent,
    deps: {
      model: resources.modelAdapter,
      leafModel: resources.leafAdapter,
      steel: resources.steel,
      signal: runSignal,
      stopSignal,
      throwIfAborted,
      ioGate: createConcurrencyGate(config.maxConcurrentSteelCalls),
      browserSessionPool: resources.browserSessionPool,
    },
    store: createSourceStore(createClaimLedger()),
    scope: leadScope,
  };
  ctx.deps.searchProvider = resolveSearchProvider(ctx, config.search);
  return ctx;
}

interface CitationReconciliation {
  citedSources: CitedSource[];
  citationsNotConfirmed: string[];
  citationsNotFetched: string[];
}

function reconcileCitations(
  markdown: string,
  fetchedSources: FetchedSource[],
  confirmedClaims: ReadonlyArray<{ url: string }>,
): CitationReconciliation {
  const citedUrls = extractMarkdownUrls(markdown);
  const byNormalizedUrl = new Map(
    fetchedSources.map((source) => [normalizeUrlForSource(source.url), source]),
  );
  const confirmedUrls = new Set(
    confirmedClaims.map((claim) => normalizeUrlForSource(claim.url)),
  );

  const citedSources: CitedSource[] = [];
  const citationsNotConfirmed: string[] = [];
  const citationsNotFetched: string[] = [];
  const seen = new Set<string>();
  for (const url of citedUrls) {
    const normalized = normalizeUrlForSource(url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const fetchedSource = byNormalizedUrl.get(normalized);
    if (!fetchedSource) {
      citationsNotFetched.push(url);
    } else if (confirmedUrls.has(normalized)) {
      citedSources.push(fetchedSource);
    } else {
      citationsNotConfirmed.push(url);
    }
  }
  return {
    citedSources,
    citationsNotConfirmed,
    citationsNotFetched,
  };
}

function extractMarkdownUrls(markdown: string): string[] {
  const urls: string[] = [];
  const urlPattern = /https?:\/\/[^\s<>"'\]]+/gi;
  for (const match of markdown.matchAll(urlPattern)) {
    urls.push(trimUrlBoundary(match[0]));
  }
  return urls;
}

function trimUrlBoundary(url: string): string {
  let trimmed = url.replace(/[.,;:!?]+$/g, "");
  while (trimmed.endsWith(")")) {
    const opens = (trimmed.match(/\(/g) ?? []).length;
    const closes = (trimmed.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    trimmed = trimmed.slice(0, -1).replace(/[.,;:!?]+$/g, "");
  }
  return trimmed;
}

function sumUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`research: timeoutMs must be > 0 (got ${timeoutMs})`);
  }

  const timeoutSignal = AbortSignal.timeout(Math.floor(timeoutMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export const __testing = {
  reconcileCitations,
};
