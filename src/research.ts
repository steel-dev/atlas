import {
  createAnthropicModelAdapter,
  createOpenAIModelAdapter,
  type ModelAdapter,
  type ModelAssistantBlock,
  type ModelMessage,
  type ModelOutputSchema,
  type ModelProvider,
  type ModelToolCall,
  type ModelToolResult,
  type UsageSummary,
} from "./model.js";
import {
  execFindInSource,
  execQuoteSource,
  execReadSourceChunk,
  type FindInSourceToolInput,
  type QuoteSourceToolInput,
  type ReadSourceChunkToolInput,
} from "./evidence-tool.js";
import {
  RESEARCH_TOOLS,
  STRUCTURED_EMIT_SYSTEM_PROMPT,
  STRUCTURED_FINALIZE_SYSTEM_PROMPT,
} from "./tool-contract.js";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  type ResearchEffort,
} from "./defaults.js";
import type {
  FetchedSource,
  SourceExtractionAttempt,
  SourceDocument,
  VerifiedSource,
} from "./sources.js";
import { createSteel } from "./steel.js";
import {
  createSourceReservations,
  createResearchCaches,
  createSteelConcurrencyGate,
  runResearchLoop,
  type ResearchLoopContext,
} from "./tools.js";
import {
  BrowserSessionPool,
  readBrowserMaxSessionsFromEnv,
} from "./browser-session-pool.js";
import { normalizeUrlForSource } from "./url.js";

const DEFAULT_RUNTIME_LIMITS = {
  safetySourceCap: 40,
  safetyMaxToolCalls: 80,
  maxConcurrentTools: 8,
  maxConcurrentSteelCalls: 4,
  defaultSearchLimit: 8,
  defaultEffort: "high",
  maxOutputTokens: 16_384,
  timeoutSynthesisReserveMs: 180_000,
} satisfies {
  safetySourceCap: number;
  safetyMaxToolCalls: number;
  maxConcurrentTools: number;
  maxConcurrentSteelCalls: number;
  defaultSearchLimit: number;
  defaultEffort: ResearchEffort;
  maxOutputTokens: number;
  timeoutSynthesisReserveMs: number;
};

export type { ModelProvider, UsageSummary } from "./model.js";
export type { ResearchEffort } from "./defaults.js";
export type {
  FetchedSource,
  SourceDocument,
  VerifiedSource,
} from "./sources.js";

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
  structured?: unknown;
  sourceDocuments?: SourceDocument[];
  usage: UsageSummary;
}

export interface ResearchOutputOptions {
  schema: Record<string, unknown>;
  name?: string;
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
      method?: string;
      markdownChars?: number;
      attempts?: SourceExtractionAttempt[];
      qualityWarnings?: string[];
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
    anthropicApiKey: anthropicApiKeyOverride,
    openaiApiKey: openaiApiKeyOverride,
    openaiBaseUrl: openaiBaseUrlOverride,
    steelApiKey: steelApiKeyOverride,
    steelBaseUrl: steelBaseUrlOverride,
    useProxy = false,
    timeoutMs,
    effort,
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
  const safetySourceCap = limits.safetySourceCap;
  const safetyMaxToolCalls = limits.safetyMaxToolCalls;
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
  const browserSessionPool = new BrowserSessionPool({
    steel,
    useProxy,
    namespace: `atlas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    signal: runSignal,
    deadlineAt: timeoutDeadlineAt,
    maxSessions: readBrowserMaxSessionsFromEnv(),
  });

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
    deadlineAt: timeoutDeadlineAt,
    synthesisReserveMs:
      timeoutMs === undefined
        ? undefined
        : timeoutSynthesisReserveMs(
            timeoutMs,
            limits.timeoutSynthesisReserveMs,
          ),
    steelConcurrencyGate: createSteelConcurrencyGate(
      limits.maxConcurrentSteelCalls,
    ),
    browserSessionPool,
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
  };

  try {
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
    const structured =
      output === undefined
        ? undefined
        : await generateStructuredOutput({
            ctx,
            model: modelAdapter,
            messages: run.messages,
            output,
            maxTokens: limits.maxOutputTokens,
            effort: effort ?? limits.defaultEffort,
            signal: runSignal,
          });

    const result: ResearchResult = {
      query,
      provider,
      model,
      runs,
      verifiedSources: citationAudit.verifiedSources,
      unverifiedCitations: citationAudit.unverifiedCitations,
      markdown,
      ...(structured !== undefined ? { structured } : {}),
      ...(includeSourceDocuments
        ? { sourceDocuments: [...sourceDocuments.values()] }
        : {}),
      usage: { ...modelAdapter.usage },
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

const FINALIZE_TOOL_NAMES = new Set([
  "read_source_chunk",
  "find_in_source",
  "quote_source",
]);
const MAX_FINALIZE_STEPS = 6;

async function generateStructuredOutput(opts: {
  ctx: ResearchLoopContext;
  model: ModelAdapter;
  messages: ModelMessage[];
  output: ResearchOutputOptions;
  maxTokens: number;
  effort: ResearchEffort;
  signal?: AbortSignal;
}): Promise<unknown> {
  const finalizeTools = RESEARCH_TOOLS.filter((tool) =>
    FINALIZE_TOOL_NAMES.has(tool.name),
  );
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
      if (parsed.ok) return parsed.value;
      break;
    }
    messages.push({
      role: "user",
      content: toolUses.map((tu) => execFinalizationTool(tu, opts.ctx)),
    });
  }

  return emitStructuredJson({
    model: opts.model,
    messages,
    output: opts.output,
    maxTokens: opts.maxTokens,
    effort: opts.effort,
    signal: opts.signal,
  });
}

function execFinalizationTool(
  tu: ModelToolCall,
  ctx: ResearchLoopContext,
): ModelToolResult {
  const run = (): { content: string; isError?: boolean } => {
    if (tu.name === "read_source_chunk") {
      return {
        content: execReadSourceChunk(
          (tu.input ?? {}) as ReadSourceChunkToolInput,
          ctx,
        ),
      };
    }
    if (tu.name === "find_in_source") {
      return {
        content: execFindInSource(
          (tu.input ?? {}) as FindInSourceToolInput,
          ctx,
        ),
      };
    }
    if (tu.name === "quote_source") {
      return {
        content: execQuoteSource((tu.input ?? {}) as QuoteSourceToolInput, ctx),
      };
    }
    return {
      content: `Tool ${tu.name} is not available while finalizing. Use find_in_source, quote_source, or read_source_chunk to verify evidence, then return the JSON.`,
      isError: true,
    };
  };
  const { content, isError } = run();
  return {
    type: "tool_result",
    tool_call_id: tu.id,
    content,
    ...(isError ? { is_error: true } : {}),
  };
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
    opts.openaiBaseUrl ?? readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
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
  auditCitationsInMarkdown,
  generateStructuredOutput,
};
