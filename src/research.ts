import {
  createAnthropicModelAdapter,
  createOpenAIModelAdapter,
  type ModelAdapter,
  type ModelProvider,
  type UsageSummary,
} from "./model.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  type ResearchEffort,
} from "./defaults.js";
import type { FetchedSource, SourceDocument, VerifiedSource } from "./sources.js";
import { createSteel } from "./steel.js";
import {
  createSourceReservations,
  createResearchCaches,
  createSteelConcurrencyGate,
  runResearchLoop,
  type ResearchLoopContext,
} from "./tools.js";
import { normalizeUrlForSource } from "./url.js";

const DEFAULT_RUNTIME_LIMITS = {
  safetySourceCap: 40,
  safetyMaxToolCalls: 80,
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 4,
  defaultSearchLimit: 8,
  defaultEffort: "high",
  maxOutputTokens: 16_384,
} satisfies {
  safetySourceCap: number;
  safetyMaxToolCalls: number;
  maxConcurrentTools: number;
  maxConcurrentSteelCalls: number;
  defaultSearchLimit: number;
  defaultEffort: ResearchEffort;
  maxOutputTokens: number;
};

export type { ModelProvider, UsageSummary } from "./model.js";
export type { ResearchEffort } from "./defaults.js";
export type { FetchedSource, SourceDocument, VerifiedSource } from "./sources.js";

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
  verifiedSources: VerifiedSource[];
  unverifiedCitations: string[];
  markdown: string;
  usage: UsageSummary;
}

export type ResearchEvent =
  | { type: "research_started" }
  | { type: "searching"; index: number; query: string }
  | {
      type: "search_results";
      index: number;
      count: number;
    }
  | {
      type: "search_failed";
      index: number;
      error: string;
    }
  | { type: "fetching"; url: string }
  | {
      type: "rate_limited";
      retryAfterSeconds: number;
      attempt: number;
      maxAttempts: number;
    }
  | {
      type: "source_fetched";
      url: string;
      title: string;
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "research_finished"; sourcesFetched: number }
  | { type: "unverified_citations"; count: number; urls: string[] }
  | { type: "written"; markdownChars: number }
  | { type: "completed"; result: ResearchResult };

export interface ResearchOptions {
  query: string;
  provider?: ModelProvider;
  model?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  steelApiKey?: string;
  steelBaseUrl?: string;
  useProxy?: boolean;
  timeoutMs?: number;
  effort?: ResearchEffort;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    provider: providerOverride,
    model: modelOverride,
    anthropicApiKey: anthropicApiKeyOverride,
    openaiApiKey: openaiApiKeyOverride,
    openaiBaseUrl: openaiBaseUrlOverride,
    steelApiKey: steelApiKeyOverride,
    steelBaseUrl: steelBaseUrlOverride,
    useProxy = false,
    timeoutMs,
    effort,
    onEvent,
    signal,
  } = opts;

  if (!query || !query.trim()) {
    throw new Error("research: query is required");
  }
  const provider = resolveProvider(providerOverride);
  const model = resolveModel(provider, modelOverride);
  const steelApiKey =
    steelApiKeyOverride ?? readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY");
  const steelBaseUrl =
    steelBaseUrlOverride ?? readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL");
  if (!steelApiKey) {
    throw new Error(
      "research: STEEL_API_KEY or ATLAS_STEEL_API_KEY is required",
    );
  }

  const limits = DEFAULT_RUNTIME_LIMITS;
  const safetySourceCap = limits.safetySourceCap;
  const safetyMaxToolCalls = limits.safetyMaxToolCalls;
  const runSignal = combineSignals(signal, timeoutMs);

  const emit = (e: ResearchEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // user callbacks must never break the research run
    }
  };
  const abort = () => runSignal?.throwIfAborted();

  const modelAdapter = createModelAdapter({
    provider,
    model,
    anthropicApiKey: anthropicApiKeyOverride,
    openaiApiKey: openaiApiKeyOverride,
    openaiBaseUrl: openaiBaseUrlOverride,
  });
  const steel = createSteel({ apiKey: steelApiKey, baseUrl: steelBaseUrl });

  const fetchedSources: FetchedSource[] = [];
  const sourceDocuments = new Map<string, SourceDocument>();

  const ctx: ResearchLoopContext = {
    model: modelAdapter,
    steel,
    fetchedSources,
    sourceDocuments,
    emit,
    abort,
    signal: runSignal,
    defaultEngine: "ddg",
    useProxy,
    sourceCap: safetySourceCap,
    maxOutputTokens: limits.maxOutputTokens,
    defaultSearchLimit: limits.defaultSearchLimit,
    maxConcurrentTools: limits.maxConcurrentTools,
    steelConcurrencyGate: createSteelConcurrencyGate(
      limits.maxConcurrentSteelCalls,
    ),
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
  };

  const run = await runResearchLoop({
    ctx,
    query,
    maxToolCalls: safetyMaxToolCalls,
    effort: effort ?? limits.defaultEffort,
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
  const citationAudit = auditCitationsInMarkdown(markdown, fetchedSources);
  if (citationAudit.unverifiedCitations.length > 0) {
    emit({
      type: "unverified_citations",
      count: citationAudit.unverifiedCitations.length,
      urls: citationAudit.unverifiedCitations,
    });
  }
  emit({ type: "written", markdownChars: markdown.length });

  const result: ResearchResult = {
    query,
    provider,
    model,
    runs,
    verifiedSources: citationAudit.verifiedSources,
    unverifiedCitations: citationAudit.unverifiedCitations,
    markdown,
    usage: { ...modelAdapter.usage },
  };

  emit({ type: "completed", result });
  return result;
}

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function resolveProvider(provider: ModelProvider | undefined): ModelProvider {
  const raw = provider ?? readEnv("ATLAS_PROVIDER");
  if (raw === "anthropic" || raw === "openai") return raw;
  if (raw) {
    throw new Error(
      `research: provider must be one of: anthropic, openai (got "${raw}")`,
    );
  }
  const hasOpenAI = Boolean(readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY"));
  const hasAnthropic = Boolean(
    readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
  );
  return hasOpenAI && !hasAnthropic ? "openai" : "anthropic";
}

function resolveModel(
  provider: ModelProvider,
  model: string | undefined,
): string {
  const raw =
    model ??
    readEnv(
      "ATLAS_MODEL",
      provider === "anthropic" ? "ATLAS_ANTHROPIC_MODEL" : "ATLAS_OPENAI_MODEL",
    );
  if (raw?.trim()) return raw.trim();
  return provider === "anthropic"
    ? DEFAULT_ANTHROPIC_MODEL
    : DEFAULT_OPENAI_MODEL;
}

function createModelAdapter(opts: {
  provider: ModelProvider;
  model: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): ModelAdapter {
  if (opts.provider === "anthropic") {
    const apiKey =
      opts.anthropicApiKey ??
      readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "research: ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY is required for provider=anthropic",
      );
    }
    return createAnthropicModelAdapter({ apiKey, model: opts.model });
  }

  const apiKey =
    opts.openaiApiKey ?? readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  const baseUrl =
    opts.openaiBaseUrl ??
    readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
  if (!apiKey) {
    throw new Error(
      "research: OPENAI_API_KEY or ATLAS_OPENAI_API_KEY is required for provider=openai",
    );
  }
  return createOpenAIModelAdapter({ apiKey, baseUrl, model: opts.model });
}

interface CitationAudit {
  verifiedSources: VerifiedSource[];
  unverifiedCitations: string[];
}

function auditCitationsInMarkdown(
  markdown: string,
  fetchedSources: FetchedSource[],
): CitationAudit {
  const citedUrls = extractMarkdownUrls(markdown);
  const byNormalizedUrl = new Map(
    fetchedSources.map((source) => [
      normalizeUrlForCitation(source.url),
      source,
    ]),
  );

  const verifiedSources: VerifiedSource[] = [];
  const unverifiedCitations: string[] = [];
  const seen = new Set<string>();
  for (const url of citedUrls) {
    const normalized = normalizeUrlForCitation(url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const fetchedSource = byNormalizedUrl.get(normalized);
    if (fetchedSource) {
      verifiedSources.push(fetchedSource);
    } else {
      unverifiedCitations.push(url);
    }
  }
  return {
    verifiedSources,
    unverifiedCitations,
  };
}

function extractMarkdownUrls(markdown: string): string[] {
  const urls: string[] = [];
  const markdownLinkPattern = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi;
  for (const match of markdown.matchAll(markdownLinkPattern)) {
    urls.push(stripTrailingUrlPunctuation(match[1]));
  }

  const bareUrlPattern = /https?:\/\/[^\s<>"')]+/gi;
  for (const match of markdown.matchAll(bareUrlPattern)) {
    urls.push(stripTrailingUrlPunctuation(match[0]));
  }
  return urls;
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/g, "");
}

function normalizeUrlForCitation(url: string): string {
  return normalizeUrlForSource(url);
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
  auditCitationsInMarkdown,
};
