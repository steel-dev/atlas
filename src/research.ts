import Anthropic from "@anthropic-ai/sdk";
import {
  WRITER_MODEL,
  writeReport,
  type CitedSource,
  type WriterEffort,
} from "./pipeline.js";
import { type Engine } from "./search.js";
import { createSteel } from "./steel.js";
import {
  createResearchCaches,
  createSourceReservations,
  createSteelGate,
  runGatherAgent,
  type AgentContext,
} from "./tools.js";

export const RESEARCH_DEFAULTS = {
  maxSources: 24,
  maxSubagentToolCalls: 48,
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 4,
} as const;

export const RESEARCH_DEPTHS = ["fast", "standard", "deep"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

export const RESEARCH_DEPTH_PRESETS = {
  fast: {
    maxSources: 8,
    maxToolCalls: 10,
    gatherMaxTokens: 2048,
    searchMode: "fallback",
    defaultSearchLimit: 5,
    gatherModel: undefined,
    writerEffort: "medium",
    writerMaxTokens: 8192,
    writerMaxSourceChars: 40_000,
    writerTotalSourceChars: 120_000,
  },
  standard: {
    maxSources: RESEARCH_DEFAULTS.maxSources,
    maxToolCalls: RESEARCH_DEFAULTS.maxSubagentToolCalls,
    gatherMaxTokens: 3072,
    searchMode: "aggregate",
    defaultSearchLimit: 8,
    gatherModel: undefined,
    writerEffort: "high",
    writerMaxTokens: 16_384,
    writerMaxSourceChars: 80_000,
    writerTotalSourceChars: 420_000,
  },
  deep: {
    maxSources: 72,
    maxToolCalls: 160,
    gatherMaxTokens: 4096,
    searchMode: "aggregate",
    defaultSearchLimit: 12,
    gatherModel: WRITER_MODEL,
    writerEffort: "max",
    writerMaxTokens: 24_576,
    writerMaxSourceChars: 100_000,
    writerTotalSourceChars: 900_000,
  },
} satisfies Record<
  ResearchDepth,
  {
    maxSources: number;
    maxToolCalls: number;
    gatherMaxTokens: number;
    searchMode: "fallback" | "aggregate";
    defaultSearchLimit: number;
    gatherModel: string | undefined;
    writerEffort: WriterEffort;
    writerMaxTokens: number;
    writerMaxSourceChars: number;
    writerTotalSourceChars: number;
  }
>;

export type { CitedSource } from "./pipeline.js";
export type { Engine } from "./search.js";

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
}

export interface ResearchResult {
  query: string;
  agent_runs: AgentRun[];
  sources: CitedSource[];
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
  | { type: "agent_finished"; sources_added: number }
  | { type: "writing"; sources_count: number }
  | { type: "written"; markdown_chars: number }
  | { type: "completed"; result: ResearchResult };

export interface ResearchOptions {
  query: string;
  anthropicApiKey: string;
  steelApiKey: string;
  steelBaseUrl?: string;
  /** Cap on cited sources. Default 16. */
  maxSources?: number;
  /** Cap on gather-agent tool calls (search / inspect / fetch / done). Default 20. */
  maxToolCalls?: number;
  /** One-knob budget/effort preset. Explicit maxSources/maxToolCalls override it. */
  depth?: ResearchDepth;
  /** Web SERP engine. */
  engine?: Engine;
  useProxy?: boolean;
  /** Override the gather model. */
  fastModel?: string;
  /** Override the writer model (Sonnet by default). */
  writerModel?: string;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey,
    steelApiKey,
    steelBaseUrl,
    maxSources: maxSourcesOverride,
    maxToolCalls: maxToolCallsOverride,
    depth = "standard",
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
  if (!(depth in RESEARCH_DEPTH_PRESETS)) {
    throw new Error(`research: depth must be one of ${RESEARCH_DEPTHS.join(", ")}`);
  }

  const depthPreset = RESEARCH_DEPTH_PRESETS[depth];
  const maxSources = maxSourcesOverride ?? depthPreset.maxSources;
  const maxToolCalls = maxToolCallsOverride ?? depthPreset.maxToolCalls;
  const gatherModel = fastModel ?? depthPreset.gatherModel;

  const emit = (e: ResearchEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // user callbacks must never break the pipeline
    }
  };
  const abort = () => signal?.throwIfAborted();

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
    signal,
    defaultEngine: engine,
    useProxy,
    fastModel: gatherModel,
    globalSourceCap: maxSources,
    gatherMaxTokens: depthPreset.gatherMaxTokens,
    searchMode: depthPreset.searchMode,
    defaultSearchLimit: depthPreset.defaultSearchLimit,
    maxConcurrentTools: RESEARCH_DEFAULTS.maxConcurrentTools,
    steelGate: createSteelGate(RESEARCH_DEFAULTS.maxConcurrentSteelCalls),
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
  };

  const gather = await runGatherAgent({
    ctx,
    query,
    max_tool_calls: maxToolCalls,
  });

  abort();
  emit({ type: "writing", sources_count: sources.length });
  const { markdown } = await writeReport({
    anthropic,
    query,
    sources,
    source_texts: sourceMarkdowns,
    model: writerModel,
    writerEffort: depthPreset.writerEffort,
    writerMaxTokens: depthPreset.writerMaxTokens,
    writerMaxSourceChars: depthPreset.writerMaxSourceChars,
    writerTotalSourceChars: depthPreset.writerTotalSourceChars,
    signal,
  });
  emit({ type: "written", markdown_chars: markdown.length });

  const result: ResearchResult = {
    query,
    agent_runs: [
      {
        source_ns: gather.source_ns,
        tool_calls: gather.tool_calls,
        finish_reason: gather.finish_reason,
      },
    ],
    sources,
    markdown,
    usage_summary: { ...usageSummary },
  };

  emit({ type: "completed", result });
  return result;
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

