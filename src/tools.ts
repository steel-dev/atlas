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
  execBrowserCdp,
  execBrowserExtract,
  execBrowserOpen,
  type BrowserCdpToolInput,
  type BrowserExtractToolInput,
  type BrowserOpenToolInput,
} from "./browser-tool.js";
import {
  execSearch,
  searchQueryCount,
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
const FREE_TOOL_NAMES = new Set([
  "plan",
  "read_source_chunk",
  "find_in_source",
  "quote_source",
]);

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

function timeoutSynthesisReason(ctx: ResearchLoopContext): string | null {
  if (ctx.deadlineAt === undefined || ctx.synthesisReserveMs === undefined) {
    return null;
  }
  const remainingMs = ctx.deadlineAt - Date.now();
  if (remainingMs > ctx.synthesisReserveMs) return null;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `timeout approaching (${remainingSeconds}s remaining)`;
}

function shouldAttemptFinalSynthesis(finishReason: string): boolean {
  return (
    finishReason === "tool call budget exhausted" ||
    finishReason === "tool execution safety budget exhausted" ||
    finishReason.startsWith("timeout approaching")
  );
}

function spendsActionBudget(tu: ModelToolCall): boolean {
  return !FREE_TOOL_NAMES.has(tu.name);
}

function actionToolCallCount(toolUses: ModelToolCall[]): number {
  return toolUses.filter(spendsActionBudget).length;
}

function budgetStatusMessage(opts: {
  actionToolCalls: number;
  maxActionToolCalls: number;
  totalToolExecutions: number;
  maxTotalToolExecutions: number;
  ctx: ResearchLoopContext;
}): string {
  const actionRemaining = Math.max(
    0,
    opts.maxActionToolCalls - opts.actionToolCalls,
  );
  const totalRemaining = Math.max(
    0,
    opts.maxTotalToolExecutions - opts.totalToolExecutions,
  );
  const sourcesRemaining = Math.max(
    0,
    opts.ctx.sourceCap - opts.ctx.fetchedSources.length,
  );
  return [
    "Budget status:",
    `action_tool_calls=${opts.actionToolCalls}/${opts.maxActionToolCalls}`,
    `action_tool_calls_remaining=${actionRemaining}`,
    `tool_execution_safety_remaining=${totalRemaining}`,
    `sources=${opts.ctx.fetchedSources.length}/${opts.ctx.sourceCap}`,
    `sources_remaining=${sourcesRemaining}`,
    "plan/read_source_chunk/find_in_source/quote_source do not spend action_tool_calls.",
  ].join(" ");
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

  if (tu.name === "browser_open") {
    try {
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: await execBrowserOpen((tu.input as BrowserOpenToolInput) ?? {}, ctx),
        },
      };
    } catch (err) {
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

  if (tu.name === "browser_cdp") {
    try {
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: await execBrowserCdp((tu.input as BrowserCdpToolInput) ?? {}, ctx),
        },
      };
    } catch (err) {
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

  if (tu.name === "browser_extract") {
    try {
      const content = await execBrowserExtract(
        (tu.input as BrowserExtractToolInput) ?? {},
        ctx,
      );
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content,
        },
      };
    } catch (err) {
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

  if (tu.name === "plan") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content:
          "Plan recorded. Continue with search/fetch, or write your final report when you have enough evidence.",
      },
    };
  }

  return {
    toolResult: {
      type: "tool_result",
      tool_call_id: tu.id,
      content:
        `Unknown tool: ${tu.name}. Available tools: ` +
        "search, fetch, read_source_chunk, find_in_source, quote_source, browser_open, browser_cdp, browser_extract, plan.",
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
  const maxTotalToolExecutions = Math.max(maxToolCalls, maxToolCalls * 2);

  ctx.emit({ type: "research_started" });

  const fetchedUrls: string[] = [];
  let toolCalls = 0;
  let totalToolExecutions = 0;
  let finishReason = "tool call budget exhausted";
  let markdown = "";
  let searchIndex = 0;

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: researchQuestionPrompt({ query }),
    },
  ];

  while (toolCalls < maxToolCalls && totalToolExecutions < maxTotalToolExecutions) {
    ctx.abort();
    const preStepTimeoutReason = timeoutSynthesisReason(ctx);
    if (preStepTimeoutReason) {
      finishReason = preStepTimeoutReason;
      break;
    }

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

    const toolUses = resp.content.filter(
      (c): c is ModelToolCall => c.type === "tool_call",
    );
    if (toolUses.length === 0) {
      messages.push({ role: "assistant", content: resp.content });
      const text = textFromContent(resp.content);
      markdown = text;
      finishReason = text ? "final report" : "empty final response";
      break;
    }

    const postStepTimeoutReason = timeoutSynthesisReason(ctx);
    if (postStepTimeoutReason) {
      finishReason = postStepTimeoutReason;
      break;
    }

    messages.push({ role: "assistant", content: resp.content });

    let remainingActionToolCalls = maxToolCalls - toolCalls;
    let remainingTotalToolExecutions =
      maxTotalToolExecutions - totalToolExecutions;
    const activeToolUses: ModelToolCall[] = [];
    const skippedToolUses: Array<{ toolUse: ModelToolCall; reason: string }> = [];
    for (const toolUse of toolUses) {
      if (remainingTotalToolExecutions <= 0) {
        skippedToolUses.push({
          toolUse,
          reason: "tool execution safety budget exhausted",
        });
        continue;
      }
      if (spendsActionBudget(toolUse) && remainingActionToolCalls <= 0) {
        skippedToolUses.push({
          toolUse,
          reason: "action tool call budget exhausted",
        });
        continue;
      }
      activeToolUses.push(toolUse);
      remainingTotalToolExecutions--;
      if (spendsActionBudget(toolUse)) remainingActionToolCalls--;
    }
    const searchIndexes = activeToolUses.map((tu) => {
      if (tu.name !== "search") return undefined;
      const start = searchIndex + 1;
      searchIndex += searchQueryCount((tu.input as SearchToolInput) ?? {});
      return start;
    });
    toolCalls += actionToolCallCount(activeToolUses);
    totalToolExecutions += activeToolUses.length;

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) => executeToolUse(tu, ctx, searchIndexes[index]),
    );
    const toolResults = [
      ...executions.map((e) => e.toolResult),
      ...skippedToolUses.map(
        ({ toolUse, reason }): ModelToolResult => ({
          type: "tool_result",
          tool_call_id: toolUse.id,
          content: `Tool not run: ${reason}.`,
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
    messages.push({
      role: "user",
      content: budgetStatusMessage({
        actionToolCalls: toolCalls,
        maxActionToolCalls: maxToolCalls,
        totalToolExecutions,
        maxTotalToolExecutions,
        ctx,
      }),
    });

    if (totalToolExecutions >= maxTotalToolExecutions) {
      finishReason = "tool execution safety budget exhausted";
      break;
    }

    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  if (!markdown && shouldAttemptFinalSynthesis(finishReason)) {
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
