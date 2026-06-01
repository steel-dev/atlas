import type { ModelProvider, UsageSummary } from "./model.js";
import type { FetchedSource, SourceDocument, CitedSource } from "./sources.js";
import {
  resolveSearchProvider,
  type SearchProvider,
} from "./search-provider.js";
import { runResearchLoop } from "./research-loop.js";
import { generateStructuredOutput } from "./structured-output.js";
import {
  resolveRunConfig,
  createRunResources,
  RUNTIME_LIMITS,
  type ResolvedRunConfig,
  type RunResources,
} from "./config-resolution.js";
import {
  createAgentScope,
  createSourceReservations,
  createResearchCaches,
  createConcurrencyGate,
  type ResearchCtx,
  type ResearchLoopEvent,
} from "./runtime.js";
import { normalizeUrlForSource } from "./url.js";

export type { ModelProvider, UsageSummary } from "./model.js";
export type { ResearchEffort } from "./defaults.js";
export type { FetchedSource, SourceDocument, CitedSource } from "./sources.js";

export interface ResearchRun {
  fetchedUrls: string[];
  toolCalls: number;
  finishReason: string;
}

export interface ResearchResult {
  query: string;
  provider: ModelProvider;
  model: string;
  runs: ResearchRun[];
  citedSources: CitedSource[];
  citationsNotFetched: string[];
  markdown: string;
  structured?: unknown;
  sourceDocuments?: SourceDocument[];
  usage: UsageSummary;
}

export interface ResearchOutputOptions {
  schema: Record<string, unknown>;
  name?: string;
}

type LeadResearchEvent =
  | { type: "citations_not_fetched"; count: number; urls: string[] }
  | { type: "written"; markdownChars: number }
  | { type: "completed"; result: ResearchResult };

export type ResearchEvent =
  | ResearchLoopEvent
  | (LeadResearchEvent & {
      /** Set on events emitted by a sub-agent (1 for the first level of
       *  delegation). Absent/0 for the lead agent. */
      depth?: number;
    });

export interface ResearchOptions {
  query: string;
  provider?: ModelProvider;
  model?: string;
  summaryModel?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  steelApiKey?: string;
  steelBaseUrl?: string;
  /** Search backend: a custom SearchProvider instance, or a built-in name
   *  ("web" = SERP scraping via Steel (default), "exa", "brave"). Defaults from
   *  ATLAS_SEARCH_PROVIDER, else "web". */
  searchProvider?: SearchProvider | string;
  /** API key for the built-in Exa provider. Env: ATLAS_EXA_API_KEY / EXA_API_KEY. */
  exaApiKey?: string;
  /** API key for the built-in Brave provider. Env: ATLAS_BRAVE_API_KEY / BRAVE_API_KEY. */
  braveApiKey?: string;
  useProxy?: boolean;
  timeoutMs?: number;
  /** Total token budget for the run (test-time compute limit), shared across
   *  the lead and all sub-agents. Omit to use the default; set to 0 for
   *  unlimited. Per-step thinking is controlled by ATLAS_THINKING_EFFORT. */
  tokenLimit?: number;
  suggestedTeamSize?: number;
  output?: ResearchOutputOptions;
  includeSourceDocuments?: boolean;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  if (!opts.query?.trim()) {
    throw new Error("research: query is required");
  }
  const config = resolveRunConfig(opts);
  const runSignal = combineSignals(opts.signal, opts.timeoutMs);
  const emit = (e: ResearchEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // user callbacks must never break the research run
    }
  };
  const abort = () => runSignal?.throwIfAborted();
  const resources = createRunResources(opts, config, runSignal, emit);

  try {
    await using leadScope = createAgentScope({
      sink: emit,
      query: opts.query,
      depth: 0,
      deadlineAt: config.timeoutDeadlineAt,
      synthesisReserveMs: config.synthesisReserveMs,
      compactionTriggerTokens: config.compactionTriggerTokens,
      compactionKeepTokens: config.compactionKeepTokens,
    });
    const ctx = buildResearchCtx({
      config,
      resources,
      leadScope,
      runSignal,
      abort,
    });

    const run = await runResearchLoop({
      ctx,
      query: opts.query,
      maxToolCalls: config.safetyMaxToolCalls,
      effort: config.thinkingEffort,
      suggestedParallelism:
        config.suggestedTeamSize >= 2 ? config.suggestedTeamSize : undefined,
    });
    const runs: ResearchRun[] = [
      {
        fetchedUrls: run.fetchedUrls,
        toolCalls: run.toolCalls,
        finishReason: run.finishReason,
      },
    ];

    abort();
    const markdown = run.markdown.trim();
    if (!markdown) {
      throw new Error(
        `research: loop did not produce a final report (${run.finishReason})`,
      );
    }
    const citations = reconcileCitations(markdown, ctx.store.fetchedSources);
    if (citations.citationsNotFetched.length > 0) {
      emit({
        type: "citations_not_fetched",
        count: citations.citationsNotFetched.length,
        urls: citations.citationsNotFetched,
      });
    }
    emit({ type: "written", markdownChars: markdown.length });
    let structured: unknown;
    if (opts.output !== undefined) {
      const structuredResult = await generateStructuredOutput({
        ctx,
        model: resources.modelAdapter,
        messages: run.messages,
        output: opts.output,
        maxTokens:
          config.agent.maxOutputTokens ?? RUNTIME_LIMITS.maxOutputTokens,
        effort: config.thinkingEffort,
        signal: runSignal,
      });
      structured = structuredResult.value;
      runs.push(...structuredResult.additionalRuns);
    }

    const result: ResearchResult = {
      query: opts.query,
      provider: config.provider,
      model: config.model,
      runs,
      citedSources: citations.citedSources,
      citationsNotFetched: citations.citationsNotFetched,
      markdown,
      ...(structured !== undefined ? { structured } : {}),
      ...(opts.includeSourceDocuments
        ? { sourceDocuments: [...ctx.store.sourceDocuments.values()] }
        : {}),
      usage:
        resources.summaryAdapter === resources.modelAdapter
          ? { ...resources.modelAdapter.usage }
          : sumUsage(
              resources.modelAdapter.usage,
              resources.summaryAdapter.usage,
            ),
    };

    emit({ type: "completed", result });
    return result;
  } finally {
    await resources.browserSessionPool.closeAll();
  }
}

// Assembles the per-run context (config/deps/store/scope) and wires the search
// provider, which needs the context it lives in.
function buildResearchCtx(args: {
  config: ResolvedRunConfig;
  resources: RunResources;
  leadScope: ResearchCtx["scope"];
  runSignal: AbortSignal | undefined;
  abort: () => void;
}): ResearchCtx {
  const { config, resources, leadScope, runSignal, abort } = args;
  const ctx: ResearchCtx = {
    config: config.agent,
    deps: {
      model: resources.modelAdapter,
      summaryModel: resources.summaryAdapter,
      steel: resources.steel,
      signal: runSignal,
      abort,
      ioGate: createConcurrencyGate(config.maxConcurrentSteelCalls),
      browserSessionPool: resources.browserSessionPool,
    },
    store: {
      fetchedSources: [],
      sourceDocuments: new Map<string, SourceDocument>(),
      sourceReservations: createSourceReservations(),
      caches: createResearchCaches(),
    },
    scope: leadScope,
  };
  ctx.deps.searchProvider = resolveSearchProvider(ctx, config.searchProvider);
  return ctx;
}

interface CitationReconciliation {
  citedSources: CitedSource[];
  citationsNotFetched: string[];
}

function reconcileCitations(
  markdown: string,
  fetchedSources: FetchedSource[],
): CitationReconciliation {
  const citedUrls = extractMarkdownUrls(markdown);
  const byNormalizedUrl = new Map(
    fetchedSources.map((source) => [normalizeUrlForSource(source.url), source]),
  );

  const citedSources: CitedSource[] = [];
  const citationsNotFetched: string[] = [];
  const seen = new Set<string>();
  for (const url of citedUrls) {
    const normalized = normalizeUrlForSource(url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const fetchedSource = byNormalizedUrl.get(normalized);
    if (fetchedSource) {
      citedSources.push(fetchedSource);
    } else {
      citationsNotFetched.push(url);
    }
  }
  return {
    citedSources,
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
  resolveRunConfig,
  generateStructuredOutput: async (
    opts: Parameters<typeof generateStructuredOutput>[0],
  ) => (await generateStructuredOutput(opts)).value,
  generateStructuredOutputWithRuns: generateStructuredOutput,
};
