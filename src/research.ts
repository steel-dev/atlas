import Anthropic from "@anthropic-ai/sdk";
import {
  WRITER_MODEL,
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

const DEFAULT_RUNTIME_LIMITS = {
  safetySourceCap: 200,
  safetyMaxToolCalls: 200,
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
  safetySourceCap: number;
  safetyMaxToolCalls: number;
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

const WRITER_MIN_SOURCE_CHARS = 4_000;
const MAX_HEADING_OUTLINE_CHARS = 4_000;

export type { CitedSource, WriterEffort } from "./pipeline.js";

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
  anthropicApiKey?: string;
  steelApiKey?: string;
  steelBaseUrl?: string;
  timeoutMs?: number;
  budgetUsd?: number;
  effort?: WriterEffort;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

type MessageStreamEvent =
  {
    type: string;
    content_block?: {
      type?: string;
      text?: string;
    };
    delta?: {
      type?: string;
      text?: string;
    };
  };

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey: anthropicApiKeyOverride,
    steelApiKey: steelApiKeyOverride,
    steelBaseUrl: steelBaseUrlOverride,
    timeoutMs,
    budgetUsd,
    effort,
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

  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    throw new Error(`research: budgetUsd must be > 0 (got ${budgetUsd})`);
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
    fastModel: limits.gatherModel,
    globalSourceCap: safetySourceCap,
    gatherMaxTokens: limits.gatherMaxTokens,
    searchMode: limits.searchMode,
    defaultSearchLimit: limits.defaultSearchLimit,
    maxConcurrentTools: limits.maxConcurrentTools,
    steelGate: createSteelGate(limits.maxConcurrentSteelCalls),
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
  };

  const gather = await runGatherAgent({
    ctx,
    query,
    max_tool_calls: safetyMaxToolCalls,
    budgetUsd,
  });
  const agentRuns: AgentRun[] = [
    {
      source_ns: gather.source_ns,
      tool_calls: gather.tool_calls,
      finish_reason: gather.finish_reason,
    },
  ];

  abort();
  emit({ type: "writing", sources_count: sources.length });
  const markdown = await writeFinalReportInThread({
    anthropic,
    query,
    sources,
    sourceTexts: sourceMarkdowns,
    messages: gather.messages,
    model: limits.writerModel,
    writerEffort: effort ?? limits.writerEffort,
    writerMaxTokens: limits.writerMaxTokens,
    writerMaxSourceChars: limits.writerMaxSourceChars,
    writerTotalSourceChars: limits.writerTotalSourceChars,
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

function markdownHeadingOutline(markdown: string): string {
  const headings = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,4}\s+\S/.test(line));

  if (headings.length === 0) return "";
  const outline = headings.join("\n").slice(0, MAX_HEADING_OUTLINE_CHARS);
  return `Document heading outline:\n${outline}\n\n`;
}

function packSourceMarkdown(markdown: string, budget: number): string {
  if (markdown.length <= budget) return markdown;

  const outline = markdownHeadingOutline(markdown);
  const truncation = "\n\n[... truncated source page ...]";
  const contentBudget = Math.max(
    WRITER_MIN_SOURCE_CHARS,
    budget - outline.length - truncation.length,
  );
  return `${outline}${markdown.slice(0, contentBudget)}${truncation}`.slice(
    0,
    budget,
  );
}

function sourceBlocks(opts: {
  sources: CitedSource[];
  sourceTexts: Map<number, string>;
  writerMaxSourceChars: number;
  writerTotalSourceChars: number;
}): string {
  const sourceBudget = Math.max(
    WRITER_MIN_SOURCE_CHARS,
    Math.min(
      opts.writerMaxSourceChars,
      Math.floor(opts.writerTotalSourceChars / Math.max(1, opts.sources.length)),
    ),
  );

  return opts.sources
    .map((source) => {
      const raw = opts.sourceTexts.get(source.n) ?? "";
      const packed = raw ? packSourceMarkdown(raw, sourceBudget) : "";
      const rawBlock = raw
        ? `\nPage content (packed to ${sourceBudget.toLocaleString()} chars):\n${packed}`
        : "\n(No page content available.)";
      return `[${source.n}] ${source.title} — ${source.url}${rawBlock}`;
    })
    .join("\n\n---\n\n");
}

async function writeFinalReportInThread(opts: {
  anthropic: Anthropic;
  query: string;
  sources: CitedSource[];
  sourceTexts: Map<number, string>;
  messages: Anthropic.MessageParam[];
  model: string;
  writerEffort: WriterEffort;
  writerMaxTokens: number;
  writerMaxSourceChars: number;
  writerTotalSourceChars: number;
  signal?: AbortSignal;
}): Promise<string> {
  const system =
    "You are the same research agent that just gathered sources. " +
    "Write a clear, comprehensive research report in Markdown answering the user's question. " +
    "Use the research trail from this thread and the committed source pages provided in the final instruction. " +
    "Cite every factual claim with bracketed source numbers, e.g. [1] or [1, 3]. " +
    "Only include claims supported by the committed source pages. " +
    "Distinguish genuinely recent progress from background context, and call out uncertainty or weak evidence when relevant. " +
    "Structure: a one-paragraph intro, body sections with H2 headings as the material demands, then a final '## Sources' section listing each source as '[n] Title — URL'.";

  const finalInstruction =
    `Research question: ${opts.query}\n\n` +
    `Committed source pages:\n${sourceBlocks({
      sources: opts.sources,
      sourceTexts: opts.sourceTexts,
      writerMaxSourceChars: opts.writerMaxSourceChars,
      writerTotalSourceChars: opts.writerTotalSourceChars,
    })}\n\n` +
    `Now write the final report. Answer the exact question first. Do not merely summarize sources; synthesize what changed, what is known, what remains uncertain, and which sources are strongest.`;

  const stream = await opts.anthropic.messages.create(
    {
      model: opts.model,
      max_tokens: opts.writerMaxTokens,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: opts.writerEffort },
      system,
      messages: [
        ...opts.messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: finalInstruction,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    },
    { signal: opts.signal },
  );

  const chunks: string[] = [];
  for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "text" &&
      event.content_block.text
    ) {
      chunks.push(event.content_block.text);
    }
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      chunks.push(event.delta.text);
    }
  }

  return chunks.join("").trim();
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

