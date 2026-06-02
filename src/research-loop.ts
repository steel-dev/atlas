import {
  totalUsageTokens,
  type ModelAssistantBlock,
  type ModelMessage,
  type ModelStepInput,
  type ModelStepResult,
  type ModelToolCall,
  type ModelToolResult,
} from "./model.js";
import {
  stopRequestedReason,
  tokenBudgetExhaustedReason,
  type ResearchCtx,
} from "./runtime.js";
import {
  estimateMessagesTokens,
  maybeCompactResearchContext,
} from "./compaction.js";
import { errorMessage } from "./errors.js";
import { parseRetryAfterSeconds } from "./steel-runtime.js";
import { normalizeUrlForSource } from "./url.js";
import {
  searchQueryCount,
  searchEnginesForFusion,
  type SearchToolInput,
} from "./search-tool.js";
import {
  executeResearchTool,
  researchToolDefinitions,
  toolSpendsActionBudget,
} from "./tool-registry.js";
import {
  EMPTY_RESPONSE_PROMPT,
  finalSynthesisPrompt,
  RESEARCH_SYSTEM_PROMPT,
  researchQuestionPrompt,
} from "./tool-contract.js";
import { createSubagentScope, SUBAGENT_MAX_TOOL_CALLS } from "./subagents.js";

const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const BUDGET_STATUS_REMAINING_RATIO = 0.3;

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

function timeoutSynthesisReason(ctx: ResearchCtx): string | null {
  if (
    ctx.scope.deadlineAt === undefined ||
    ctx.scope.synthesisReserveMs === undefined
  ) {
    return null;
  }
  const remainingMs = ctx.scope.deadlineAt - Date.now();
  if (remainingMs > ctx.scope.synthesisReserveMs) return null;
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `timeout approaching (${remainingSeconds}s remaining)`;
}

function shouldAttemptFinalSynthesis(finishReason: string): boolean {
  return (
    finishReason === "tool call budget exhausted" ||
    finishReason === "tool execution safety budget exhausted" ||
    finishReason === "token budget exhausted" ||
    finishReason === "stop requested" ||
    finishReason.startsWith("timeout approaching")
  );
}

function spendsActionBudget(tu: ModelToolCall): boolean {
  return toolSpendsActionBudget(tu.name);
}

function actionToolCallCount(toolUses: ModelToolCall[]): number {
  return toolUses.filter(spendsActionBudget).length;
}

function budgetStatusMessage(opts: {
  actionToolCalls: number;
  maxActionToolCalls: number;
  totalToolExecutions: number;
  maxTotalToolExecutions: number;
  ctx: ResearchCtx;
}): string | null {
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
    opts.ctx.config.sourceCap - opts.ctx.store.fetchedSources.length,
  );
  const tokenLimit = opts.ctx.config.tokenLimit ?? 0;
  const tokensUsed =
    tokenLimit > 0 ? totalUsageTokens(opts.ctx.deps.model.usage) : 0;
  const tokenRatio =
    tokenLimit > 0
      ? Math.max(0, (tokenLimit - tokensUsed) / tokenLimit)
      : Number.POSITIVE_INFINITY;
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
    totalRatio <= BUDGET_STATUS_REMAINING_RATIO ||
    tokenRatio <= BUDGET_STATUS_REMAINING_RATIO;

  if (!shouldShow) return null;

  return [
    "Budget status:",
    `action_tool_calls=${opts.actionToolCalls}/${opts.maxActionToolCalls}`,
    `action_tool_calls_remaining=${actionRemaining}`,
    `tool_execution_safety_remaining=${totalRemaining}`,
    `sources=${opts.ctx.store.fetchedSources.length}/${opts.ctx.config.sourceCap}`,
    `sources_remaining=${sourcesRemaining}`,
    ...(tokenLimit > 0 ? [`tokens_used=${tokensUsed}/${tokenLimit}`] : []),
    "plan/read_source/search_sources/digest_source do not spend action_tool_calls.",
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

export async function runResearchLoop(opts: {
  ctx: ResearchCtx;
  query: string;
  maxToolCalls?: number;
  systemPrompt?: string;
  suggestedParallelism?: number;
}): Promise<ResearchLoopResult> {
  const { ctx, query } = opts;
  const systemPrompt = opts.systemPrompt ?? RESEARCH_SYSTEM_PROMPT;
  const tools = researchToolDefinitions({
    includeDelegation:
      (ctx.scope.depth ?? 0) < (ctx.config.maxDelegationDepth ?? 0),
  });
  const isSubagent = (ctx.scope.depth ?? 0) > 0;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxTotalToolExecutions = maxToolCalls * 2;
  const subagents = createSubagentScope(
    ctx,
    SUBAGENT_MAX_TOOL_CALLS,
    runResearchLoop,
  );

  const streamReportStep = (
    input: ModelStepInput,
  ): Promise<ModelStepResult> => {
    const stepStream = ctx.deps.model.stepStream;
    if (isSubagent || !stepStream) return ctx.deps.model.step(input);
    return stepStream(input, {
      onStart: () => ctx.scope.emit({ type: "report-boundary" }),
      onText: (text) => ctx.scope.emit({ type: "report-delta", text }),
    });
  };

  if (!isSubagent) ctx.scope.emit({ type: "research_started" });

  const fetchedUrls: string[] = [];
  let toolCalls = 0;
  let totalToolExecutions = 0;
  let finishReason = "tool call budget exhausted";
  let markdown = "";
  let searchIndex = 0;
  let nudgedEmptyResponse = false;
  // Real-tokens-per-(char/4)-estimate ratio, updated from each step's reported
  // prompt size so compaction tracks true context cost (CJK/JSON cost more).
  let tokenCalibration = 1;

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: researchQuestionPrompt({
        query,
        suggestedParallelism: isSubagent
          ? undefined
          : opts.suggestedParallelism,
      }),
    },
  ];

  while (
    toolCalls < maxToolCalls &&
    totalToolExecutions < maxTotalToolExecutions
  ) {
    ctx.deps.abort();
    const preStepStopReason = stopRequestedReason(ctx);
    if (preStepStopReason) {
      finishReason = preStepStopReason;
      break;
    }
    const preStepTimeoutReason = timeoutSynthesisReason(ctx);
    if (preStepTimeoutReason) {
      finishReason = preStepTimeoutReason;
      break;
    }

    const tokenBudgetReason = tokenBudgetExhaustedReason(ctx);
    if (tokenBudgetReason) {
      finishReason = tokenBudgetReason;
      break;
    }

    await maybeCompactResearchContext({
      ctx,
      messages,
      calibration: tokenCalibration,
    });

    const promptTokenEstimate = estimateMessagesTokens(messages);
    let resp: ModelStepResult;
    try {
      resp = await streamReportStep({
        system: systemPrompt,
        tools,
        messages,
        maxTokens: ctx.config.maxOutputTokens ?? 2048,
        providerOptions: ctx.config.exploreProviderOptions,
        signal: ctx.deps.signal,
      });
    } catch (err) {
      if (ctx.deps.signal?.aborted) throw err;
      const message = errorMessage(err);
      finishReason = `api error: ${message}`;
      break;
    }
    if (promptTokenEstimate > 0 && (resp.inputTokens ?? 0) > 0) {
      tokenCalibration = Math.min(
        8,
        Math.max(1, (resp.inputTokens as number) / promptTokenEstimate),
      );
    }

    const toolUses = resp.content.filter(
      (c): c is ModelToolCall => c.type === "tool_call",
    );
    if (toolUses.length === 0) {
      const text = textFromContent(resp.content);
      if (text) {
        messages.push({ role: "assistant", content: resp.content });
        markdown = text;
        finishReason = "final report";
        break;
      }
      if (!nudgedEmptyResponse && resp.content.length > 0) {
        nudgedEmptyResponse = true;
        messages.push({ role: "assistant", content: resp.content });
        messages.push({ role: "user", content: EMPTY_RESPONSE_PROMPT });
        continue;
      }
      if (resp.content.length > 0) {
        messages.push({ role: "assistant", content: resp.content });
      }
      finishReason = "empty final response";
      break;
    }

    const postStepStopReason = stopRequestedReason(ctx);
    if (postStepStopReason) {
      finishReason = postStepStopReason;
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

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.config.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) =>
        executeResearchTool(tu, ctx, {
          subagents,
          searchIndex: searchIndexes[index],
        }),
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

    if (totalToolExecutions >= maxTotalToolExecutions) {
      finishReason = "tool execution safety budget exhausted";
      break;
    }

    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  const canSalvageAfterApiError =
    finishReason.startsWith("api error") && ctx.store.fetchedSources.length > 0;
  if (
    !markdown &&
    (shouldAttemptFinalSynthesis(finishReason) || canSalvageAfterApiError)
  ) {
    ctx.deps.abort();
    messages.push({
      role: "user",
      content: finalSynthesisPrompt(finishReason),
    });

    try {
      const resp = await streamReportStep({
        system: systemPrompt,
        messages,
        maxTokens: ctx.config.maxOutputTokens ?? 2048,
        providerOptions: ctx.config.finalizeProviderOptions,
        signal: ctx.deps.signal,
      });
      messages.push({ role: "assistant", content: resp.content });
      const text = textFromContent(resp.content);
      markdown = text;
      finishReason = text
        ? `final report after ${finishReason}`
        : `empty final synthesis after ${finishReason}`;
    } catch (err) {
      if (ctx.deps.signal?.aborted) throw err;
      const message = errorMessage(err);
      finishReason = `final synthesis api error after ${finishReason}: ${message}`;
    }
  }

  const leftoverFetchedUrls = await subagents.settle();
  if (leftoverFetchedUrls.length > 0) fetchedUrls.push(...leftoverFetchedUrls);

  if (!isSubagent) {
    ctx.scope.emit({
      type: "research_finished",
      sourcesFetched: ctx.store.fetchedSources.length,
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
  normalizeUrlForSource,
  parseRetryAfterSeconds,
  searchEnginesForFusion,
};
