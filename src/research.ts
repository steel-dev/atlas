import Anthropic from "@anthropic-ai/sdk";
import { type CitedSource, type ResearchEffort } from "./pipeline.js";
import { createSteel } from "./steel.js";
import {
  createOpenReservations,
  createResearchCaches,
  createSteelGate,
  runGatherAgent,
  type AgentContext,
  type OpenedSourceFile,
} from "./tools.js";
import { normalizeUrlForSource } from "./url.js";

const DEFAULT_RUNTIME_LIMITS = {
  safetySourceCap: 40,
  safetyMaxToolCalls: 80,
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 4,
  defaultSearchLimit: 8,
  agentEffort: "high",
  agentMaxTokens: 16_384,
} satisfies {
  safetySourceCap: number;
  safetyMaxToolCalls: number;
  maxConcurrentTools: number;
  maxConcurrentSteelCalls: number;
  defaultSearchLimit: number;
  agentEffort: ResearchEffort;
  agentMaxTokens: number;
};

export type { CitedSource, ResearchEffort } from "./pipeline.js";

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AgentRun {
  opened_urls: string[];
  tool_calls: number;
  finish_reason: string;
}

export interface ResearchResult {
  query: string;
  agent_runs: AgentRun[];
  sources: CitedSource[];
  unverified_citations: string[];
  markdown: string;
  usage_summary: UsageSummary;
}

export type ResearchEvent =
  | { type: "agent_started" }
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
      retry_after_seconds: number;
      attempt: number;
      max_attempts: number;
    }
  | {
      type: "page_opened";
      url: string;
      title: string;
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "agent_finished"; pages_opened: number }
  | { type: "unverified_citations"; count: number; urls: string[] }
  | { type: "written"; markdown_chars: number }
  | { type: "completed"; result: ResearchResult };

export interface ResearchOptions {
  query: string;
  anthropicApiKey?: string;
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
    anthropicApiKey: anthropicApiKeyOverride,
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
  const anthropicApiKey =
    anthropicApiKeyOverride ??
    readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
  const steelApiKey =
    steelApiKeyOverride ?? readEnv("ATLAS_STEEL_API_KEY", "STEEL_API_KEY");
  const steelBaseUrl =
    steelBaseUrlOverride ?? readEnv("ATLAS_STEEL_BASE_URL", "STEEL_BASE_URL");
  if (!anthropicApiKey) {
    throw new Error(
      "research: ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY is required",
    );
  }
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
      // user callbacks must never break the pipeline
    }
  };
  const abort = () => runSignal?.throwIfAborted();

  const anthropic = new Anthropic({ apiKey: anthropicApiKey, maxRetries: 5 });
  const usageSummary = instrumentAnthropic(anthropic);
  const steel = createSteel({ apiKey: steelApiKey, baseUrl: steelBaseUrl });

  const openedPages: CitedSource[] = [];
  const openedSourceFiles = new Map<string, OpenedSourceFile>();

  const ctx: AgentContext = {
    anthropic,
    steel,
    openedPages,
    openedSourceFiles,
    emit,
    abort,
    signal: runSignal,
    defaultEngine: "ddg",
    useProxy,
    openedPageCap: safetySourceCap,
    gatherMaxTokens: limits.agentMaxTokens,
    defaultSearchLimit: limits.defaultSearchLimit,
    maxConcurrentTools: limits.maxConcurrentTools,
    steelGate: createSteelGate(limits.maxConcurrentSteelCalls),
    openReservations: createOpenReservations(),
    caches: createResearchCaches(),
  };

  const gather = await runGatherAgent({
    ctx,
    query,
    max_tool_calls: safetyMaxToolCalls,
    effort: effort ?? limits.agentEffort,
  });
  const agentRuns: AgentRun[] = [
    {
      opened_urls: gather.opened_urls,
      tool_calls: gather.tool_calls,
      finish_reason: gather.finish_reason,
    },
  ];

  abort();
  const markdown = gather.markdown.trim();
  if (!markdown) {
    throw new Error(
      `research: agent did not produce a final report (${gather.finish_reason})`,
    );
  }
  const citationAudit = auditCitationsInMarkdown(markdown, openedPages);
  if (citationAudit.unverified_citations.length > 0) {
    emit({
      type: "unverified_citations",
      count: citationAudit.unverified_citations.length,
      urls: citationAudit.unverified_citations,
    });
  }
  emit({ type: "written", markdown_chars: markdown.length });

  const result: ResearchResult = {
    query,
    agent_runs: agentRuns,
    sources: citationAudit.sources,
    unverified_citations: citationAudit.unverified_citations,
    markdown,
    usage_summary: { ...usageSummary },
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

interface CitationAudit {
  sources: CitedSource[];
  unverified_citations: string[];
}

function auditCitationsInMarkdown(
  markdown: string,
  openedSources: CitedSource[],
): CitationAudit {
  const citedUrls = extractMarkdownUrls(markdown);
  const byNormalizedUrl = new Map(
    openedSources.map((source) => [
      normalizeUrlForCitation(source.url),
      source,
    ]),
  );

  const citedSources: CitedSource[] = [];
  const unverifiedCitations: string[] = [];
  const seen = new Set<string>();
  for (const url of citedUrls) {
    const normalized = normalizeUrlForCitation(url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const openedSource = byNormalizedUrl.get(normalized);
    if (openedSource) {
      citedSources.push(openedSource);
    } else {
      unverifiedCitations.push(url);
    }
  }
  return {
    sources: citedSources,
    unverified_citations: unverifiedCitations,
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

/**
 * Wrap `client.messages.create` so every call's `usage` is accumulated into
 * the returned summary object.
 */
function instrumentAnthropic(client: Anthropic): UsageSummary {
  const usage: UsageSummary = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const origCreate = client.messages.create.bind(client.messages);
  const wrapped = async (
    ...args: Parameters<typeof origCreate>
  ): Promise<Awaited<ReturnType<typeof origCreate>>> => {
    const res = await origCreate(...args);
    if (res && typeof res === "object" && "usage" in res && res.usage) {
      const u = res.usage;
      usage.input_tokens += u.input_tokens ?? 0;
      usage.output_tokens += u.output_tokens ?? 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    }
    return res;
  };
  client.messages.create = wrapped as typeof client.messages.create;
  return usage;
}

export const __testing = {
  auditCitationsInMarkdown,
};
