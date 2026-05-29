import type {
  ModelAssistantBlock,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  ModelToolResult,
} from "./model.js";
import type { ResearchEffort } from "./defaults.js";
import type { ResearchLoopContext, ResearchLoopEvent } from "./runtime.js";
import { createSteelConcurrencyGate } from "./runtime.js";
import { errorMessage } from "./errors.js";
import { parseRetryAfterSeconds } from "./steel-runtime.js";
import {
  execFetch,
  execFetchMany,
  normalizeFetchUrl,
  type FetchManyToolInput,
  type FetchToolInput,
} from "./fetch-tool.js";
import {
  execDigestSource,
  execFindInSource,
  execQuoteSource,
  execReadSourceChunk,
  execSearchSources,
  type DigestSourceToolInput,
  type FindInSourceToolInput,
  type QuoteSourceToolInput,
  type ReadSourceChunkToolInput,
  type SearchSourcesToolInput,
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
  SUBAGENT_SYSTEM_PROMPT,
} from "./tool-contract.js";

export {
  createBudgetLedger,
  createResearchCaches,
  createSourceReservations,
  createSteelConcurrencyGate,
} from "./runtime.js";
export type {
  BudgetLedger,
  ResearchCaches,
  ResearchLoopContext,
  ResearchLoopEvent,
  SourceReservations,
  SteelConcurrencyGate,
} from "./runtime.js";

const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;
const DELEGATE_MAX_TASKS = 4;
const SUBAGENT_MAX_TOOL_CALLS = 20;
const DELEGATE_MIN_REMAINING_ACTION_CALLS = 2;
const DELEGATE_MIN_RUNTIME_MS = 30_000;
const SUBAGENT_SYNTHESIS_RESERVE_MS = 45_000;
const SUBAGENT_FINDINGS_MAX_CHARS = 4_000;
const BUDGET_STATUS_REMAINING_RATIO = 0.3;
const FREE_TOOL_NAMES = new Set([
  "plan",
  "read_source_chunk",
  "search_sources",
  "digest_source",
  "find_in_source",
  "quote_source",
]);

/** Delegation is opt-in: the `delegate` tool is only exposed when the context
 *  allows another level of depth. With maxDelegationDepth unset (the default
 *  for direct runResearchLoop callers and tests), delegation is off entirely. */
function toolsForContext(ctx: ResearchLoopContext): ModelToolDefinition[] {
  if ((ctx.depth ?? 0) >= (ctx.maxDelegationDepth ?? 0)) {
    return RESEARCH_TOOLS.filter((tool) => tool.name !== "delegate");
  }
  return RESEARCH_TOOLS;
}

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
  /** Sub-agent-fetched URLs bubbled up by `delegate` so the lead run accounts
   *  for the whole delegation tree's fetches. */
  fetchedUrls?: string[];
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
}): string | null {
  const actionRemaining = opts.ctx.budget
    ? opts.ctx.budget.remainingActionCalls
    : Math.max(0, opts.maxActionToolCalls - opts.actionToolCalls);
  const totalRemaining = opts.ctx.budget
    ? opts.ctx.budget.remainingToolExecutions
    : Math.max(0, opts.maxTotalToolExecutions - opts.totalToolExecutions);
  const sourcesRemaining = Math.max(
    0,
    opts.ctx.sourceCap - opts.ctx.fetchedSources.length,
  );
  const actionRatio =
    opts.maxActionToolCalls > 0
      ? actionRemaining / opts.maxActionToolCalls
      : Number.POSITIVE_INFINITY;
  const totalRatio =
    opts.maxTotalToolExecutions > 0
      ? totalRemaining / opts.maxTotalToolExecutions
      : Number.POSITIVE_INFINITY;
  const shouldShow =
    actionRatio <= BUDGET_STATUS_REMAINING_RATIO ||
    totalRatio <= BUDGET_STATUS_REMAINING_RATIO;

  if (!shouldShow) return null;

  return [
    "Budget status:",
    `action_tool_calls=${opts.actionToolCalls}/${opts.maxActionToolCalls}`,
    `action_tool_calls_remaining=${actionRemaining}`,
    `tool_execution_safety_remaining=${totalRemaining}`,
    `sources=${opts.ctx.fetchedSources.length}/${opts.ctx.sourceCap}`,
    `sources_remaining=${sourcesRemaining}`,
    "plan/read_source_chunk/search_sources/digest_source/find_in_source/quote_source do not spend action_tool_calls.",
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
        fetchedUrls: out.fetchedUrls,
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

  if (tu.name === "fetch_many") {
    try {
      const out = await execFetchMany((tu.input as FetchManyToolInput) ?? {}, ctx);
      return {
        fetchedUrl: out.fetchedUrl,
        fetchedUrls: out.fetchedUrls,
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

  if (tu.name === "search_sources") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: execSearchSources(
          (tu.input as SearchSourcesToolInput) ?? {},
          ctx,
        ),
      },
    };
  }

  if (tu.name === "digest_source") {
    try {
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: await execDigestSource(
            (tu.input as DigestSourceToolInput) ?? {},
            ctx,
          ),
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

  if (tu.name === "find_in_source") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: execFindInSource(
          (tu.input as FindInSourceToolInput) ?? {},
          ctx,
        ),
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
          content: await execBrowserOpen(
            (tu.input as BrowserOpenToolInput) ?? {},
            ctx,
          ),
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
          content: await execBrowserCdp(
            (tu.input as BrowserCdpToolInput) ?? {},
            ctx,
          ),
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

  if (tu.name === "delegate") {
    try {
      const delegation = await runDelegate(
        (tu.input as DelegateToolInput) ?? {},
        ctx,
      );
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: delegation.content,
        },
        ...(delegation.fetchedUrls.length > 0
          ? { fetchedUrls: delegation.fetchedUrls }
          : {}),
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
        "search, fetch, fetch_many, read_source_chunk, search_sources, digest_source, find_in_source, quote_source, browser_open, browser_cdp, browser_extract, delegate, plan.",
      is_error: true,
    },
  };
}

interface DelegateToolInput {
  tasks?: Array<{ question?: string } | null>;
}

function readDelegateTasks(input: DelegateToolInput): string[] {
  const raw = Array.isArray(input?.tasks) ? input.tasks : [];
  const seen = new Set<string>();
  const tasks: string[] = [];
  for (const entry of raw) {
    const question = String(entry?.question ?? "").trim();
    if (!question || seen.has(question)) continue;
    seen.add(question);
    tasks.push(question);
    if (tasks.length >= DELEGATE_MAX_TASKS) break;
  }
  return tasks;
}

function tagEventDepth(
  event: ResearchLoopEvent,
  depth: number,
): ResearchLoopEvent {
  return event.depth === undefined ? { ...event, depth } : event;
}

function forkContextForSubagent(
  ctx: ResearchLoopContext,
  question: string,
  timing: SubagentTiming,
): ResearchLoopContext {
  const depth = (ctx.depth ?? 0) + 1;
  return {
    ...ctx,
    query: question,
    depth,
    ...(timing.deadlineAt !== undefined ? { deadlineAt: timing.deadlineAt } : {}),
    ...(timing.synthesisReserveMs !== undefined
      ? { synthesisReserveMs: timing.synthesisReserveMs }
      : {}),
    browserSessionLease: undefined,
    emit: (event) => ctx.emit(tagEventDepth(event, depth)),
  };
}

interface SubagentTiming {
  deadlineAt?: number;
  synthesisReserveMs?: number;
}

function subagentTiming(ctx: ResearchLoopContext): SubagentTiming | string {
  if (ctx.deadlineAt === undefined || ctx.synthesisReserveMs === undefined) {
    return {};
  }

  const now = Date.now();
  const leadDeadlineAt = ctx.deadlineAt;
  const leadReserveMs = Math.max(0, ctx.synthesisReserveMs);
  const subagentDeadlineAt = leadDeadlineAt - leadReserveMs;
  const subagentReserveMs = Math.min(
    leadReserveMs,
    SUBAGENT_SYNTHESIS_RESERVE_MS,
  );
  const usableMs = subagentDeadlineAt - now - subagentReserveMs;
  if (usableMs < DELEGATE_MIN_RUNTIME_MS) {
    const remainingSeconds = Math.max(0, Math.ceil((leadDeadlineAt - now) / 1000));
    const reserveSeconds = Math.ceil(leadReserveMs / 1000);
    return `Error: not enough remaining time to delegate (${remainingSeconds}s left; ${reserveSeconds}s reserved for lead finalization). Investigate or finalize directly.`;
  }

  return {
    deadlineAt: subagentDeadlineAt,
    synthesisReserveMs: subagentReserveMs,
  };
}

function truncateFindings(text: string): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= SUBAGENT_FINDINGS_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SUBAGENT_FINDINGS_MAX_CHARS)}\n... [truncated]`;
}

function subagentSources(
  ctx: ResearchLoopContext,
  fetchedUrls: string[],
): Array<{ source_id?: string; url: string; title?: string }> {
  const seen = new Set<string>();
  const sources: Array<{ source_id?: string; url: string; title?: string }> =
    [];
  for (const url of fetchedUrls) {
    const key = normalizeFetchUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const document = ctx.sourceDocuments.get(key);
    sources.push(
      document
        ? {
            source_id: document.sourceId,
            url: document.url,
            title: document.title,
          }
        : { url },
    );
  }
  return sources;
}

interface DelegateOutcome {
  content: string;
  fetchedUrls: string[];
}

async function runDelegate(
  input: DelegateToolInput,
  ctx: ResearchLoopContext,
): Promise<DelegateOutcome> {
  if ((ctx.depth ?? 0) >= (ctx.maxDelegationDepth ?? 0)) {
    return {
      content:
        "Error: delegation is not available here. Research this directly with search/fetch.",
      fetchedUrls: [],
    };
  }
  const tasks = readDelegateTasks(input);
  if (tasks.length === 0) {
    return {
      content:
        "Error: delegate requires `tasks` to be a non-empty array of objects with a `question` string.",
      fetchedUrls: [],
    };
  }
  if (
    ctx.budget &&
    ctx.budget.remainingActionCalls < DELEGATE_MIN_REMAINING_ACTION_CALLS
  ) {
    return {
      content:
        "Error: not enough remaining tool budget to delegate. Investigate the most important angle directly.",
      fetchedUrls: [],
    };
  }
  const timing = subagentTiming(ctx);
  if (typeof timing === "string") {
    return {
      content: timing,
      fetchedUrls: [],
    };
  }

  const maxConcurrent =
    ctx.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
  const gate = ctx.subagentGate ?? createSteelConcurrencyGate(maxConcurrent);
  ctx.emit({ type: "delegation_started", tasks });
  const outcomes = await mapWithConcurrency(tasks, tasks.length, (question) =>
    gate.run(async () => {
      ctx.emit({ type: "subagent_started", task: question });
      try {
        const run = await runResearchLoop({
          ctx: forkContextForSubagent(ctx, question, timing),
          query: question,
          maxToolCalls: SUBAGENT_MAX_TOOL_CALLS,
          effort: ctx.subagentEffort,
          systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        });
        const findings = truncateFindings(run.markdown);
        ctx.emit({
          type: "subagent_finished",
          task: question,
          sourcesFetched: run.fetchedUrls.length,
          toolCalls: run.toolCalls,
          finishReason: run.finishReason,
        });
        return {
          summary: {
            task: question,
            findings: findings || `(no findings; ${run.finishReason})`,
            sources: subagentSources(ctx, run.fetchedUrls),
            tool_calls: run.toolCalls,
            finish_reason: run.finishReason,
          },
          fetchedUrls: run.fetchedUrls,
        };
      } catch (err) {
        ctx.abort();
        return {
          summary: {
            task: question,
            error: err instanceof Error ? err.message : String(err),
          },
          fetchedUrls: [] as string[],
        };
      }
    }),
  );
  return {
    content: JSON.stringify(
      { delegated: outcomes.map((outcome) => outcome.summary) },
      null,
      2,
    ),
    fetchedUrls: outcomes.flatMap((outcome) => outcome.fetchedUrls),
  };
}

export async function runResearchLoop(opts: {
  ctx: ResearchLoopContext;
  query: string;
  maxToolCalls?: number;
  effort?: ResearchEffort;
  systemPrompt?: string;
}): Promise<ResearchLoopResult> {
  const { ctx, query } = opts;
  const systemPrompt = opts.systemPrompt ?? RESEARCH_SYSTEM_PROMPT;
  const tools = toolsForContext(ctx);
  const isSubagent = (ctx.depth ?? 0) > 0;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxTotalToolExecutions = Math.max(maxToolCalls, maxToolCalls * 2);

  if (!isSubagent) ctx.emit({ type: "research_started" });

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

  while (
    toolCalls < maxToolCalls &&
    totalToolExecutions < maxTotalToolExecutions
  ) {
    ctx.abort();
    const preStepTimeoutReason = timeoutSynthesisReason(ctx);
    if (preStepTimeoutReason) {
      finishReason = preStepTimeoutReason;
      break;
    }

    let resp: { content: ModelAssistantBlock[] };
    try {
      resp = await ctx.model.step({
        system: systemPrompt,
        tools,
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

    let remainingActionToolCalls = Math.min(
      maxToolCalls - toolCalls,
      ctx.budget ? ctx.budget.remainingActionCalls : Number.POSITIVE_INFINITY,
    );
    let remainingTotalToolExecutions = Math.min(
      maxTotalToolExecutions - totalToolExecutions,
      ctx.budget
        ? ctx.budget.remainingToolExecutions
        : Number.POSITIVE_INFINITY,
    );
    const activeToolUses: ModelToolCall[] = [];
    const skippedToolUses: Array<{ toolUse: ModelToolCall; reason: string }> =
      [];
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
    const actionCallsThisStep = actionToolCallCount(activeToolUses);
    toolCalls += actionCallsThisStep;
    totalToolExecutions += activeToolUses.length;
    ctx.budget?.consume(actionCallsThisStep, activeToolUses.length);

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
      if (execution.fetchedUrls) {
        fetchedUrls.push(...execution.fetchedUrls);
      }
    }

    messages.push({ role: "user", content: toolResults });
    const budgetStatus = budgetStatusMessage({
      actionToolCalls: toolCalls,
      maxActionToolCalls: maxToolCalls,
      totalToolExecutions,
      maxTotalToolExecutions,
      ctx,
    });
    if (budgetStatus) {
      messages.push({
        role: "user",
        content: budgetStatus,
      });
    }

    if (
      totalToolExecutions >= maxTotalToolExecutions ||
      (ctx.budget && ctx.budget.remainingToolExecutions <= 0)
    ) {
      finishReason = "tool execution safety budget exhausted";
      break;
    }

    if (
      toolCalls >= maxToolCalls ||
      (ctx.budget && ctx.budget.remainingActionCalls <= 0)
    ) {
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
        system: systemPrompt,
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

  if (!isSubagent) {
    ctx.emit({
      type: "research_finished",
      sourcesFetched: ctx.fetchedSources.length,
    });
  }

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
