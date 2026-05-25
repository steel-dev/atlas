import Anthropic from "@anthropic-ai/sdk";
import {
  WRITER_MODEL,
  writeReport,
  type CitedSource,
  type WriterEffort,
} from "./pipeline.js";
import { createSteel } from "./steel.js";
import {
  createResearchCaches,
  createSourceReservations,
  createSteelGate,
  runGatherAgent,
  type AgentContext,
} from "./tools.js";

const DEFAULT_RESEARCH_PLAN = {
  sourceHardCap: 24,
  maxToolCalls: 48,
  coverageMaxToolCalls: 12,
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 4,
  gatherMaxTokens: 3072,
  searchMode: "aggregate",
  defaultSearchLimit: 8,
  gatherModel: undefined,
  writerModel: WRITER_MODEL,
  writerEffort: "high",
  writerMaxTokens: 16_384,
  writerMaxSourceChars: 80_000,
  writerTotalSourceChars: 420_000,
} satisfies {
  sourceHardCap: number;
  maxToolCalls: number;
  coverageMaxToolCalls: number;
  maxConcurrentTools: number;
  maxConcurrentSteelCalls: number;
  gatherMaxTokens: number;
  searchMode: "fallback" | "aggregate";
  defaultSearchLimit: number;
  gatherModel: string | undefined;
  writerModel: string;
  writerEffort: WriterEffort;
  writerMaxTokens: number;
  writerMaxSourceChars: number;
  writerTotalSourceChars: number;
};

export type { CitedSource } from "./pipeline.js";

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AgentRun {
  source_ns: number[];
  tool_calls: number;
  finish_reason: string;
  phase: "initial" | "coverage";
}

export interface ResearchResult {
  query: string;
  agent_runs: AgentRun[];
  sources: CitedSource[];
  markdown: string;
  usage_summary: UsageSummary;
}

export type ResearchEvent =
  | { type: "agent_started"; phase?: "initial" | "coverage" }
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
  | { type: "inspecting"; url: string }
  | { type: "steel_fallback"; url: string; reason: string }
  | {
      type: "rate_limited";
      retry_after_seconds: number;
      attempt: number;
      max_attempts: number;
    }
  | {
      type: "source_committed";
      url: string;
      n: number;
      title: string;
    }
  | { type: "source_error"; url: string; error: string }
  | {
      type: "agent_finished";
      sources_added: number;
      phase?: "initial" | "coverage";
    }
  | { type: "writing"; sources_count: number }
  | { type: "written"; markdown_chars: number }
  | { type: "completed"; result: ResearchResult };

export interface ResearchOptions {
  query: string;
  anthropicApiKey?: string;
  steelApiKey?: string;
  steelBaseUrl?: string;
  timeoutMs?: number;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey: anthropicApiKeyOverride,
    steelApiKey: steelApiKeyOverride,
    steelBaseUrl: steelBaseUrlOverride,
    timeoutMs,
    onEvent,
    signal,
  } = opts;

  if (!query || !query.trim()) {
    throw new Error("research: query is required");
  }
  const anthropicApiKey = anthropicApiKeyOverride ?? readEnv(
    "ATLAS_ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY",
  );
  const steelApiKey = steelApiKeyOverride ?? readEnv(
    "ATLAS_STEEL_API_KEY",
    "STEEL_API_KEY",
  );
  const steelBaseUrl = steelBaseUrlOverride ?? readEnv(
    "ATLAS_STEEL_BASE_URL",
    "STEEL_BASE_URL",
  );
  if (!anthropicApiKey) {
    throw new Error(
      "research: ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY is required",
    );
  }
  if (!steelApiKey) {
    throw new Error("research: STEEL_API_KEY or ATLAS_STEEL_API_KEY is required");
  }

  const plan = DEFAULT_RESEARCH_PLAN;
  const sourceHardCap = plan.sourceHardCap;
  const maxToolCalls = plan.maxToolCalls;
  const coverageMaxToolCalls = splitCoverageToolBudget(
    maxToolCalls,
    plan.coverageMaxToolCalls,
  );
  const initialMaxToolCalls = maxToolCalls - coverageMaxToolCalls;
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

  const sources: CitedSource[] = [];
  const sourceUrls = new Set<string>();
  const sourceMarkdowns = new Map<number, string>();

  const ctx: AgentContext = {
    anthropic,
    steel,
    sources,
    sourceUrls,
    sourceMarkdowns,
    emit,
    abort,
    signal: runSignal,
    defaultEngine: "ddg",
    useProxy: false,
    fastModel: plan.gatherModel,
    globalSourceCap: sourceHardCap,
    gatherMaxTokens: plan.gatherMaxTokens,
    searchMode: plan.searchMode,
    defaultSearchLimit: plan.defaultSearchLimit,
    maxConcurrentTools: plan.maxConcurrentTools,
    steelGate: createSteelGate(plan.maxConcurrentSteelCalls),
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
  };

  const gather = await runGatherAgent({
    ctx,
    query,
    max_tool_calls: initialMaxToolCalls,
    phase: "initial",
  });
  const agentRuns: AgentRun[] = [
    {
      source_ns: gather.source_ns,
      tool_calls: gather.tool_calls,
      finish_reason: gather.finish_reason,
      phase: gather.phase,
    },
  ];

  if (coverageMaxToolCalls > 0 && sources.length < sourceHardCap) {
    const coverage = await runGatherAgent({
      ctx,
      query,
      max_tool_calls: coverageMaxToolCalls,
      phase: "coverage",
    });
    agentRuns.push({
      source_ns: coverage.source_ns,
      tool_calls: coverage.tool_calls,
      finish_reason: coverage.finish_reason,
      phase: coverage.phase,
    });
  }

  abort();
  emit({ type: "writing", sources_count: sources.length });
  const { markdown } = await writeReport({
    anthropic,
    query,
    sources,
    source_texts: sourceMarkdowns,
    model: plan.writerModel,
    writerEffort: plan.writerEffort,
    writerMaxTokens: plan.writerMaxTokens,
    writerMaxSourceChars: plan.writerMaxSourceChars,
    writerTotalSourceChars: plan.writerTotalSourceChars,
    signal: runSignal,
  });
  emit({ type: "written", markdown_chars: markdown.length });

  const result: ResearchResult = {
    query,
    agent_runs: agentRuns,
    sources,
    markdown,
    usage_summary: { ...usageSummary },
  };

  emit({ type: "completed", result });
  return result;
}

function splitCoverageToolBudget(
  maxToolCalls: number,
  presetCoverageMaxToolCalls: number,
): number {
  if (presetCoverageMaxToolCalls <= 0 || maxToolCalls <= 1) return 0;
  return Math.min(
    presetCoverageMaxToolCalls,
    Math.floor(maxToolCalls * 0.25),
    maxToolCalls - 1,
  );
}

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
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

