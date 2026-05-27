import type {
  ModelAssistantBlock,
  ModelMessage,
  ModelToolCall,
  ModelToolResult,
} from "./model.js";
import type { ResearchEffort } from "./defaults.js";
import type { ResearchLoopContext } from "./runtime.js";
import { errorMessage } from "./errors.js";
import { parseRetryAfterSeconds } from "./steel-runtime.js";
import {
  execFetch,
  normalizeFetchUrl,
  type FetchToolInput,
} from "./fetch-tool.js";
import {
  execFindInSource,
  execQuoteSource,
  execReadSourceChunk,
  type FindInSourceToolInput,
  type QuoteSourceToolInput,
  type ReadSourceChunkToolInput,
} from "./evidence-tool.js";
import {
  execSearch,
  searchEnginesInFallbackOrder,
  type SearchToolInput,
} from "./search-tool.js";
import {
  finalSynthesisPrompt,
  RESEARCH_SYSTEM_PROMPT,
  RESEARCH_TOOLS,
  researchQuestionPrompt,
} from "./tool-contract.js";

export {
  createResearchCaches,
  createSourceReservations,
  createSteelConcurrencyGate,
} from "./runtime.js";
export type {
  ResearchCaches,
  ResearchLoopContext,
  ResearchLoopEvent,
  SourceReservations,
  SteelConcurrencyGate,
} from "./runtime.js";

const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;

export interface ResearchLoopResult {
  fetchedUrls: string[];
  toolCalls: number;
  finishReason: string;
  messages: ModelMessage[];
  markdown: string;
}

function textFromContent(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

interface ToolExecution {
  toolResult: ModelToolResult;
  fetchedUrl?: string;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(normalizedLimit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function executeToolUse(
  tu: ModelToolCall,
  ctx: ResearchLoopContext,
  searchIndex?: number,
): Promise<ToolExecution> {
  if (tu.name === "search") {
    try {
      const text = await execSearch(
        (tu.input as SearchToolInput) ?? {},
        ctx,
        searchIndex ?? 0,
      );
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: text,
        },
      };
    } catch (err) {
      ctx.abort();
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        },
      };
    }
  }

  if (tu.name === "fetch") {
    try {
      const out = await execFetch((tu.input as FetchToolInput) ?? {}, ctx);
      return {
        fetchedUrl: out.fetchedUrl,
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: out.text,
        },
      };
    } catch (err) {
      ctx.abort();
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        },
      };
    }
  }

  if (tu.name === "read_source_chunk") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: execReadSourceChunk(
          (tu.input as ReadSourceChunkToolInput) ?? {},
          ctx,
        ),
      },
    };
  }

  if (tu.name === "find_in_source") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: execFindInSource((tu.input as FindInSourceToolInput) ?? {}, ctx),
      },
    };
  }

  if (tu.name === "quote_source") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: execQuoteSource((tu.input as QuoteSourceToolInput) ?? {}, ctx),
      },
    };
  }

  return {
    toolResult: {
      type: "tool_result",
      tool_call_id: tu.id,
      content:
        `Unknown tool: ${tu.name}. Available tools: ` +
        "search, fetch, read_source_chunk, find_in_source, quote_source.",
      is_error: true,
    },
  };
}

export async function runResearchLoop(opts: {
  ctx: ResearchLoopContext;
  query: string;
  maxToolCalls?: number;
  effort?: ResearchEffort;
}): Promise<ResearchLoopResult> {
  const { ctx, query } = opts;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  ctx.emit({ type: "research_started" });

  const fetchedUrls: string[] = [];
  let toolCalls = 0;
  let finishReason = "tool call budget exhausted";
  let markdown = "";
  let searchIndex = 0;

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: researchQuestionPrompt({ query }),
    },
  ];

  while (toolCalls < maxToolCalls) {
    ctx.abort();

    let resp: { content: ModelAssistantBlock[] };
    try {
      resp = await ctx.model.step({
        system: RESEARCH_SYSTEM_PROMPT,
        tools: RESEARCH_TOOLS,
        messages,
        maxTokens: ctx.maxOutputTokens ?? 2048,
        effort: opts.effort,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const message = errorMessage(err);
      finishReason = `api error: ${message}`;
      break;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (c): c is ModelToolCall => c.type === "tool_call",
    );
    if (toolUses.length === 0) {
      const text = textFromContent(resp.content);
      markdown = text;
      finishReason = text ? "final report" : "empty final response";
      break;
    }

    const remainingToolCalls = maxToolCalls - toolCalls;
    const activeToolUses = toolUses.slice(0, remainingToolCalls);
    const skippedToolUses = toolUses.slice(remainingToolCalls);
    const searchIndexes = activeToolUses.map((tu) =>
      tu.name === "search" ? ++searchIndex : undefined,
    );
    toolCalls += activeToolUses.length;

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) => executeToolUse(tu, ctx, searchIndexes[index]),
    );
    const toolResults = [
      ...executions.map((e) => e.toolResult),
      ...skippedToolUses.map(
        (tu): ModelToolResult => ({
          type: "tool_result",
          tool_call_id: tu.id,
          content: "Tool not run: tool call budget exhausted.",
          is_error: true,
        }),
      ),
    ];
    for (const execution of executions) {
      if (execution.fetchedUrl !== undefined) {
        fetchedUrls.push(execution.fetchedUrl);
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  if (!markdown && finishReason === "tool call budget exhausted") {
    ctx.abort();
    messages.push({
      role: "user",
      content: finalSynthesisPrompt(finishReason),
    });

    try {
      const resp = await ctx.model.step({
        system: RESEARCH_SYSTEM_PROMPT,
        messages,
        maxTokens: ctx.maxOutputTokens ?? 2048,
        effort: opts.effort,
        signal: ctx.signal,
      });
      messages.push({ role: "assistant", content: resp.content });
      const text = textFromContent(resp.content);
      markdown = text;
      finishReason = text
        ? `final report after ${finishReason}`
        : `empty final synthesis after ${finishReason}`;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const message = errorMessage(err);
      finishReason = `final synthesis api error after ${finishReason}: ${message}`;
    }
  }

  ctx.emit({
    type: "research_finished",
    sourcesFetched: fetchedUrls.length,
  });

  return {
    fetchedUrls: [...fetchedUrls],
    toolCalls,
    finishReason,
    messages: [...messages],
    markdown,
  };
}

export const __testing = {
  normalizeFetchUrl,
  parseRetryAfterSeconds,
  searchEnginesInFallbackOrder,
};
