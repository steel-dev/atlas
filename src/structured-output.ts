import type {
  ModelAdapter,
  ModelAssistantBlock,
  ModelMessage,
  ModelOutputSchema,
  ModelToolCall,
  ModelToolDefinition,
} from "./model.js";
import {
  STRUCTURED_EMIT_SYSTEM_PROMPT,
  STRUCTURED_FINALIZE_SYSTEM_PROMPT,
} from "./tool-contract.js";
import {
  executeFinalizeTool,
  finalizeToolDefinitions,
} from "./tool-registry.js";
import type { ResearchEffort } from "./defaults.js";
import type { ResearchCtx } from "./runtime.js";
import { runResearchLoop } from "./research-loop.js";
import type { ResearchOutputOptions, ResearchRun } from "./research.js";

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

function textFromBlocks(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

export async function generateStructuredOutput(opts: {
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
      ctx: { ...opts.ctx, scope },
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
