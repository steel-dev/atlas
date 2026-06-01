import {
  createAnthropicModelAdapter,
  createOpenAIModelAdapter,
  wrapModelAdapterWithConcurrency,
  type ModelAdapter,
  type ModelAssistantBlock,
  type ModelMessage,
  type ModelOutputSchema,
  type ModelProvider,
  type ModelToolDefinition,
  type ModelToolCall,
  type UsageSummary,
} from "./model.js";
import {
  STRUCTURED_EMIT_SYSTEM_PROMPT,
  STRUCTURED_FINALIZE_SYSTEM_PROMPT,
} from "./tool-contract.js";
import {
  executeFinalizeTool,
  finalizeToolDefinitions,
} from "./tool-registry.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_SUMMARY_MODEL,
  DEFAULT_OPENAI_MODEL,
  type ResearchEffort,
} from "./defaults.js";
import type {
  FetchedSource,
  SourceExtractionAttempt,
  SourceDocument,
  CitedSource,
} from "./sources.js";
import { createSteel } from "./steel.js";
import {
  resolveSearchProvider,
  type SearchProvider,
} from "./search-provider.js";
import {
  createAgentScope,
  createBudgetLedger,
  createSourceReservations,
  createResearchCaches,
  createSteelConcurrencyGate,
  runResearchLoop,
  type ResearchCtx,
} from "./tools.js";
import {
  BrowserSessionPool,
  defaultBrowserMaxSessions,
  readBrowserIdleTtlMsFromEnv,
  readBrowserMaxSessionsFromEnv,
} from "./browser-session-pool.js";
import { normalizeUrlForSource } from "./url.js";

const DEFAULT_RUNTIME_LIMITS = {
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 10,
  maxDelegationDepth: 1,
  maxConcurrentSubagents: 3,
  defaultSearchLimit: 8,
  maxOutputTokens: 16_384,
  timeoutSynthesisReserveMs: 180_000,
  compactionTriggerTokens: 200_000,
  compactionKeepTokens: 100_000,
  subagentCompactionTriggerTokens: 100_000,
  subagentCompactionKeepTokens: 50_000,
} satisfies {
  maxConcurrentTools: number;
  maxConcurrentSteelCalls: number;
  maxDelegationDepth: number;
  maxConcurrentSubagents: number;
  defaultSearchLimit: number;
  maxOutputTokens: number;
  timeoutSynthesisReserveMs: number;
  compactionTriggerTokens: number;
  compactionKeepTokens: number;
  subagentCompactionTriggerTokens: number;
  subagentCompactionKeepTokens: number;
};

// Caps total in-flight model connections across the lead, every sub-agent, and
// their compaction/digest calls — the spawn/join tree runs concurrently, so this
// bounds it to the provider's concurrent-connection limit. Derived from the
// sub-agent fan-out width (lead + sub-agents) unless ATLAS_MAX_CONCURRENT_MODEL_CALLS
// overrides it.
const MODEL_CALL_HEADROOM = 1;

// Total token budget = the single test-time compute knob. Tool-call and source
// safety caps are derived from it (and floored) so the token budget — not a
// hand-tuned effort multiplier — is what governs how far a run scales.
const DEFAULT_TOKEN_LIMIT = 2_000_000;
const TOKENS_PER_TOOL_CALL = 8_000;
const TOKENS_PER_SOURCE = 20_000;
const MIN_SAFETY_TOOL_CALLS = 40;
const MIN_SAFETY_SOURCE_CAP = 80;
// Thinking stays always-on adaptive; this is only the per-step effort hint.
// Override with ATLAS_THINKING_EFFORT (e.g. =max for system-card parity).
const DEFAULT_THINKING_EFFORT: ResearchEffort = "high";
const MAX_TEAM_SIZE = 8;

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

export type ResearchEvent = (
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
      method?: string;
      markdownChars?: number;
      attempts?: SourceExtractionAttempt[];
      qualityWarnings?: string[];
    }
  | { type: "source_error"; url: string; error: string }
  | { type: "research_finished"; sourcesFetched: number }
  | {
      type: "context_compacted";
      tokensBefore: number;
      tokensAfter: number;
      foldedMessages: number;
    }
  | { type: "delegation_started"; tasks: string[] }
  | { type: "subagent_started"; task: string }
  | {
      type: "subagent_finished";
      task: string;
      sourcesFetched: number;
      toolCalls: number;
      finishReason: string;
    }
  | { type: "citations_not_fetched"; count: number; urls: string[] }
  | { type: "written"; markdownChars: number }
  | { type: "completed"; result: ResearchResult }
) & {
  /** Set on events emitted by a sub-agent (1 for the first level of
   *  delegation). Absent/0 for the lead agent. */
  depth?: number;
};

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
  const {
    query,
    provider: providerOverride,
    model: modelOverride,
    summaryModel: summaryModelOverride,
    anthropicApiKey: anthropicApiKeyOverride,
    openaiApiKey: openaiApiKeyOverride,
    openaiBaseUrl: openaiBaseUrlOverride,
    steelApiKey: steelApiKeyOverride,
    steelBaseUrl: steelBaseUrlOverride,
    searchProvider: searchProviderOverride,
    exaApiKey: exaApiKeyOverride,
    braveApiKey: braveApiKeyOverride,
    useProxy = false,
    timeoutMs,
    tokenLimit: tokenLimitOverride,
    suggestedTeamSize: suggestedTeamSizeOverride,
    output,
    includeSourceDocuments = false,
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
  const thinkingEffort = resolveThinkingEffort();
  const tokenLimit =
    tokenLimitOverride ??
    readIntEnv("ATLAS_TOKEN_LIMIT", 0) ??
    DEFAULT_TOKEN_LIMIT;
  // Caps are derived from the budget (unlimited tokens fall back to the default
  // budget for sizing) so the token limit binds before these safety backstops.
  const effectiveLimitForCaps =
    tokenLimit > 0 ? tokenLimit : DEFAULT_TOKEN_LIMIT;
  const safetyMaxToolCalls = Math.max(
    MIN_SAFETY_TOOL_CALLS,
    Math.ceil(effectiveLimitForCaps / TOKENS_PER_TOOL_CALL),
  );
  const safetySourceCap = Math.max(
    MIN_SAFETY_SOURCE_CAP,
    Math.ceil(effectiveLimitForCaps / TOKENS_PER_SOURCE),
  );
  const maxDelegationDepth =
    readIntEnv("ATLAS_MAX_DELEGATION_DEPTH", 0) ?? limits.maxDelegationDepth;
  const suggestedTeamSize = Math.min(
    MAX_TEAM_SIZE,
    Math.max(
      1,
      suggestedTeamSizeOverride ?? readIntEnv("ATLAS_TEAM_SIZE", 1) ?? 1,
    ),
  );
  const maxConcurrentSubagents = Math.max(
    readIntEnv("ATLAS_MAX_SUBAGENTS", 1) ?? limits.maxConcurrentSubagents,
    suggestedTeamSize,
  );
  const maxConcurrentModelCalls =
    readIntEnv("ATLAS_MAX_CONCURRENT_MODEL_CALLS", 1) ??
    maxConcurrentSubagents + MODEL_CALL_HEADROOM;
  // Set ATLAS_COMPACTION_TRIGGER_TOKENS=0 to disable compaction. Lower it for
  // models with a sub-1M context window.
  const compactionTriggerTokens =
    readIntEnv("ATLAS_COMPACTION_TRIGGER_TOKENS", 0) ??
    limits.compactionTriggerTokens;
  const compactionKeepTokens =
    readIntEnv("ATLAS_COMPACTION_KEEP_TOKENS", 0) ??
    limits.compactionKeepTokens;
  const timeoutDeadlineAt =
    timeoutMs === undefined ? undefined : Date.now() + Math.floor(timeoutMs);
  const runSignal = combineSignals(signal, timeoutMs);

  const emit = (e: ResearchEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // user callbacks must never break the research run
    }
  };
  const abort = () => runSignal?.throwIfAborted();

  const modelCallGate = createSteelConcurrencyGate(maxConcurrentModelCalls);
  const modelAdapter = wrapModelAdapterWithConcurrency(
    createModelAdapter({
      provider,
      model,
      anthropicApiKey: anthropicApiKeyOverride,
      openaiApiKey: openaiApiKeyOverride,
      openaiBaseUrl: openaiBaseUrlOverride,
    }),
    modelCallGate,
  );
  const summaryModelName = resolveSummaryModel(
    provider,
    summaryModelOverride,
    model,
  );
  const summaryAdapter =
    summaryModelName === model
      ? modelAdapter
      : wrapModelAdapterWithConcurrency(
          createModelAdapter({
            provider,
            model: summaryModelName,
            anthropicApiKey: anthropicApiKeyOverride,
            openaiApiKey: openaiApiKeyOverride,
            openaiBaseUrl: openaiBaseUrlOverride,
          }),
          modelCallGate,
        );
  const steel = createSteel({ apiKey: steelApiKey, baseUrl: steelBaseUrl });

  const fetchedSources: FetchedSource[] = [];
  const sourceDocuments = new Map<string, SourceDocument>();
  const browserSessionPool = new BrowserSessionPool({
    steel,
    useProxy,
    namespace: `atlas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    signal: runSignal,
    deadlineAt: timeoutDeadlineAt,
    maxSessions:
      readBrowserMaxSessionsFromEnv() ??
      defaultBrowserMaxSessions(maxConcurrentSubagents),
    idleTtlMs: readBrowserIdleTtlMsFromEnv(),
  });

  try {
    await using leadScope = createAgentScope({
      sink: emit,
      query,
      depth: 0,
      deadlineAt: timeoutDeadlineAt,
      synthesisReserveMs:
        timeoutMs === undefined
          ? undefined
          : timeoutSynthesisReserveMs(
              timeoutMs,
              limits.timeoutSynthesisReserveMs,
            ),
      compactionTriggerTokens,
      compactionKeepTokens,
    });
    const ctx: ResearchCtx = {
      config: {
        defaultEngine: "ddg",
        useProxy,
        sourceCap: safetySourceCap,
        maxOutputTokens: limits.maxOutputTokens,
        defaultSearchLimit: limits.defaultSearchLimit,
        maxConcurrentTools: limits.maxConcurrentTools,
        subagentCompactionTriggerTokens: limits.subagentCompactionTriggerTokens,
        subagentCompactionKeepTokens: limits.subagentCompactionKeepTokens,
        tokenLimit,
        maxDelegationDepth,
        maxConcurrentSubagents,
        subagentEffort: thinkingEffort,
      },
      deps: {
        model: modelAdapter,
        summaryModel: summaryAdapter,
        steel,
        signal: runSignal,
        abort,
        steelConcurrencyGate: createSteelConcurrencyGate(
          limits.maxConcurrentSteelCalls,
        ),
        subagentGate: createSteelConcurrencyGate(maxConcurrentSubagents),
        browserSessionPool,
      },
      store: {
        fetchedSources,
        sourceDocuments,
        sourceReservations: createSourceReservations(),
        caches: createResearchCaches(),
        budget: createBudgetLedger(
          safetyMaxToolCalls,
          Math.max(safetyMaxToolCalls, safetyMaxToolCalls * 2),
        ),
      },
      scope: leadScope,
    };
    ctx.deps.searchProvider = resolveSearchProvider(ctx, {
      instance:
        searchProviderOverride && typeof searchProviderOverride !== "string"
          ? searchProviderOverride
          : undefined,
      kind:
        (typeof searchProviderOverride === "string"
          ? searchProviderOverride
          : undefined) ?? readEnv("ATLAS_SEARCH_PROVIDER"),
      exaApiKey:
        exaApiKeyOverride ?? readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY"),
      braveApiKey:
        braveApiKeyOverride ?? readEnv("ATLAS_BRAVE_API_KEY", "BRAVE_API_KEY"),
    });

    const run = await runResearchLoop({
      ctx,
      query,
      maxToolCalls: safetyMaxToolCalls,
      effort: thinkingEffort,
      suggestedParallelism:
        suggestedTeamSize >= 2 ? suggestedTeamSize : undefined,
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
    const citations = reconcileCitations(markdown, fetchedSources);
    if (citations.citationsNotFetched.length > 0) {
      emit({
        type: "citations_not_fetched",
        count: citations.citationsNotFetched.length,
        urls: citations.citationsNotFetched,
      });
    }
    emit({ type: "written", markdownChars: markdown.length });
    let structured: unknown;
    if (output !== undefined) {
      const structuredResult = await generateStructuredOutput({
        ctx,
        model: modelAdapter,
        messages: run.messages,
        output,
        maxTokens: limits.maxOutputTokens,
        effort: thinkingEffort,
        signal: runSignal,
      });
      structured = structuredResult.value;
      runs.push(...structuredResult.additionalRuns);
    }

    const result: ResearchResult = {
      query,
      provider,
      model,
      runs,
      citedSources: citations.citedSources,
      citationsNotFetched: citations.citationsNotFetched,
      markdown,
      ...(structured !== undefined ? { structured } : {}),
      ...(includeSourceDocuments
        ? { sourceDocuments: [...sourceDocuments.values()] }
        : {}),
      usage:
        summaryAdapter === modelAdapter
          ? { ...modelAdapter.usage }
          : sumUsage(modelAdapter.usage, summaryAdapter.usage),
    };

    emit({ type: "completed", result });
    return result;
  } finally {
    await browserSessionPool.closeAll();
  }
}

function textFromBlocks(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

const MAX_FINALIZE_STEPS = 6;
const MAX_STRUCTURED_RESEARCH_RETRIES = 1;
const STRUCTURED_RESEARCH_MAX_TOOL_CALLS = 8;

const REQUEST_MORE_RESEARCH_TOOL: ModelToolDefinition = {
  name: "request_more_research",
  description:
    "Request one focused additional research pass when required evidence is missing from the completed transcript. Use only for a concrete gap that prevents correct JSON.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The focused fact, source, or verification gap that needs one more research pass.",
      },
    },
    required: ["question"],
  },
};

interface StructuredOutputResult {
  value: unknown;
  additionalRuns: ResearchRun[];
}

type StructuredFinalizeAttempt =
  | { kind: "value"; value: unknown }
  | { kind: "more_research"; query: string };

async function generateStructuredOutput(opts: {
  ctx: ResearchCtx;
  model: ModelAdapter;
  messages: ModelMessage[];
  output: ResearchOutputOptions;
  maxTokens: number;
  effort: ResearchEffort;
  signal?: AbortSignal;
}): Promise<StructuredOutputResult> {
  let messages = opts.messages;
  const additionalRuns: ResearchRun[] = [];

  for (let retry = 0; retry <= MAX_STRUCTURED_RESEARCH_RETRIES; retry++) {
    const attempt = await runStructuredFinalizeAttempt({
      ...opts,
      messages,
      allowMoreResearch: retry < MAX_STRUCTURED_RESEARCH_RETRIES,
    });
    if (attempt.kind === "value") {
      return { value: attempt.value, additionalRuns };
    }

    await using scope = opts.ctx.scope.derive({
      depth: opts.ctx.config.maxDelegationDepth ?? 1,
    });
    const run = await runResearchLoop({
      ctx: {
        ...opts.ctx,
        store: {
          ...opts.ctx.store,
          budget: createBudgetLedger(
            STRUCTURED_RESEARCH_MAX_TOOL_CALLS,
            STRUCTURED_RESEARCH_MAX_TOOL_CALLS * 2,
          ),
        },
        scope,
      },
      query: `Additional research requested while finalizing structured output: ${attempt.query}`,
      maxToolCalls: STRUCTURED_RESEARCH_MAX_TOOL_CALLS,
      effort: opts.effort,
    });
    additionalRuns.push({
      fetchedUrls: run.fetchedUrls,
      toolCalls: run.toolCalls,
      finishReason: `structured follow-up: ${run.finishReason}`,
    });
    messages = [
      ...messages,
      {
        role: "user",
        content: `Structured finalization requested additional research: ${attempt.query}`,
      },
      ...run.messages,
      {
        role: "user",
        content: `Additional structured-output research finished (${run.finishReason}). Retry the JSON using the expanded transcript.`,
      },
    ];
  }

  const value = await emitStructuredJson({
    model: opts.model,
    messages,
    output: opts.output,
    maxTokens: opts.maxTokens,
    effort: opts.effort,
    signal: opts.signal,
  });
  return { value, additionalRuns };
}

async function runStructuredFinalizeAttempt(opts: {
  ctx: ResearchCtx;
  model: ModelAdapter;
  messages: ModelMessage[];
  output: ResearchOutputOptions;
  maxTokens: number;
  effort: ResearchEffort;
  signal?: AbortSignal;
  allowMoreResearch: boolean;
}): Promise<StructuredFinalizeAttempt> {
  const finalizeTools = finalizeToolDefinitions();
  if (opts.allowMoreResearch) {
    finalizeTools.push(REQUEST_MORE_RESEARCH_TOOL);
  }
  const messages: ModelMessage[] = [
    ...opts.messages,
    { role: "user", content: structuredOutputPrompt(opts.output) },
  ];

  for (let step = 0; step < MAX_FINALIZE_STEPS; step++) {
    opts.signal?.throwIfAborted();
    const resp = await opts.model.step({
      system: STRUCTURED_FINALIZE_SYSTEM_PROMPT,
      tools: finalizeTools,
      messages,
      maxTokens: opts.maxTokens,
      effort: opts.effort,
      signal: opts.signal,
    });
    messages.push({ role: "assistant", content: resp.content });
    const toolUses = resp.content.filter(
      (block): block is ModelToolCall => block.type === "tool_call",
    );
    if (toolUses.length === 0) {
      const parsed = tryParseJsonOutput(textFromBlocks(resp.content));
      if (parsed.ok) return { kind: "value", value: parsed.value };
      break;
    }
    const moreResearch = toolUses.find(
      (tu) => tu.name === REQUEST_MORE_RESEARCH_TOOL.name,
    );
    if (moreResearch) {
      return {
        kind: "more_research",
        query: readMoreResearchQuestion(moreResearch.input),
      };
    }
    const finalizeResults = await Promise.all(
      toolUses.map((tu) => executeFinalizeTool(tu, opts.ctx)),
    );
    messages.push({
      role: "user",
      content: finalizeResults.map((result) => result.toolResult),
    });
  }

  const value = await emitStructuredJson({
    model: opts.model,
    messages,
    output: opts.output,
    maxTokens: opts.maxTokens,
    effort: opts.effort,
    signal: opts.signal,
  });
  return { kind: "value", value };
}

function readMoreResearchQuestion(input: unknown): string {
  if (
    input &&
    typeof input === "object" &&
    "question" in input &&
    typeof input.question === "string" &&
    input.question.trim()
  ) {
    return input.question.trim();
  }
  return "Verify the missing facts needed for the structured JSON output.";
}

async function emitStructuredJson(opts: {
  model: ModelAdapter;
  messages: ModelMessage[];
  output: ResearchOutputOptions;
  maxTokens: number;
  effort: ResearchEffort;
  signal?: AbortSignal;
}): Promise<unknown> {
  const schema = modelOutputSchema(opts.output);
  const messages: ModelMessage[] = [
    ...opts.messages,
    { role: "user", content: structuredOutputPrompt(opts.output) },
  ];
  try {
    return await runStructuredEmitStep({ ...opts, messages, schema });
  } catch {
    return runStructuredEmitStep({ ...opts, messages });
  }
}

async function runStructuredEmitStep(opts: {
  model: ModelAdapter;
  messages: ModelMessage[];
  maxTokens: number;
  effort: ResearchEffort;
  signal?: AbortSignal;
  schema?: ModelOutputSchema;
}): Promise<unknown> {
  const resp = await opts.model.step({
    system: STRUCTURED_EMIT_SYSTEM_PROMPT,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    effort: opts.effort,
    outputSchema: opts.schema,
    signal: opts.signal,
  });
  return parseJsonOutput(textFromBlocks(resp.content));
}

function modelOutputSchema(output: ResearchOutputOptions): ModelOutputSchema {
  return {
    name: sanitizeSchemaName(output.name ?? "atlas_research_output"),
    schema: output.schema,
    strict: true,
  };
}

function sanitizeSchemaName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64);
  return normalized || "atlas_research_output";
}

function structuredOutputPrompt(output: ResearchOutputOptions): string {
  return [
    "Using only the research transcript above, return a JSON object matching the provided schema.",
    "Do not include Markdown fences or explanatory prose outside the JSON object.",
    "Schema:",
    JSON.stringify(output.schema),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("structured output was empty");
  const candidates = [
    trimmed,
    fencedJson(trimmed),
    substringBetween(trimmed, "{", "}"),
    substringBetween(trimmed, "[", "]"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next likely JSON span
    }
  }
  throw new Error("structured output was not valid JSON");
}

function tryParseJsonOutput(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: parseJsonOutput(text) };
  } catch {
    return { ok: false };
  }
}

function fencedJson(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function substringBetween(
  text: string,
  startChar: string,
  endChar: string,
): string | null {
  const start = text.indexOf(startChar);
  const end = text.lastIndexOf(endChar);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function readIntEnv(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= min ? n : undefined;
}

function resolveThinkingEffort(): ResearchEffort {
  const raw = readEnv("ATLAS_THINKING_EFFORT");
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "max") {
    return raw;
  }
  if (raw) {
    throw new Error(
      `research: ATLAS_THINKING_EFFORT must be one of: low, medium, high, max (got "${raw}")`,
    );
  }
  return DEFAULT_THINKING_EFFORT;
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

function resolveSummaryModel(
  provider: ModelProvider,
  summaryModel: string | undefined,
  mainModel: string,
): string {
  const raw = summaryModel ?? readEnv("ATLAS_SUMMARY_MODEL");
  if (raw?.trim()) return raw.trim();
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_SUMMARY_MODEL : mainModel;
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
    opts.openaiBaseUrl ?? readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
  if (!apiKey) {
    throw new Error(
      "research: OPENAI_API_KEY or ATLAS_OPENAI_API_KEY is required for provider=openai",
    );
  }
  return createOpenAIModelAdapter({ apiKey, baseUrl, model: opts.model });
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
    fetchedSources.map((source) => [
      normalizeUrlForCitation(source.url),
      source,
    ]),
  );

  const citedSources: CitedSource[] = [];
  const citationsNotFetched: string[] = [];
  const seen = new Set<string>();
  for (const url of citedUrls) {
    const normalized = normalizeUrlForCitation(url);
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

function timeoutSynthesisReserveMs(
  timeoutMs: number,
  maxReserveMs: number,
): number {
  const normalizedTimeoutMs = Math.floor(timeoutMs);
  const preferredReserveMs = Math.max(
    15_000,
    Math.floor(normalizedTimeoutMs * 0.25),
  );
  return Math.min(
    maxReserveMs,
    preferredReserveMs,
    Math.max(1_000, Math.floor(normalizedTimeoutMs * 0.5)),
  );
}

export const __testing = {
  reconcileCitations,
  generateStructuredOutput: async (
    opts: Parameters<typeof generateStructuredOutput>[0],
  ) => (await generateStructuredOutput(opts)).value,
  generateStructuredOutputWithRuns: generateStructuredOutput,
};
