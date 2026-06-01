import {
  totalUsageTokens,
  type ModelAssistantBlock,
  type ModelMessage,
  type ModelStepResult,
  type ModelToolCall,
  type ModelToolResult,
} from "./model.js";
import type { ResearchEffort } from "./defaults.js";
import { createConcurrencyGate, type ResearchCtx } from "./runtime.js";
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
  SPAWN_MAX_TASKS,
  type SubagentScope,
  type SubagentSummary,
} from "./tool-registry.js";
import {
  EMPTY_RESPONSE_PROMPT,
  finalSynthesisPrompt,
  RESEARCH_SYSTEM_PROMPT,
  researchQuestionPrompt,
  SUBAGENT_SYSTEM_PROMPT,
} from "./tool-contract.js";

const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const SUBAGENT_MAX_TOOL_CALLS = 20;
const SUBAGENT_MIN_RUNTIME_MS = 30_000;
const SUBAGENT_SYNTHESIS_RESERVE_MS = 45_000;
const SUBAGENT_FINDINGS_MAX_CHARS = 4_000;
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
    finishReason.startsWith("timeout approaching")
  );
}

function tokenBudgetExhaustedReason(ctx: ResearchCtx): string | null {
  if (!ctx.config.tokenLimit || ctx.config.tokenLimit <= 0) return null;
  if (totalUsageTokens(ctx.deps.model.usage) < ctx.config.tokenLimit)
    return null;
  return "token budget exhausted";
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

interface SubagentTiming {
  deadlineAt?: number;
  synthesisReserveMs?: number;
}

function subagentTiming(ctx: ResearchCtx): SubagentTiming | string {
  if (
    ctx.scope.deadlineAt === undefined ||
    ctx.scope.synthesisReserveMs === undefined
  ) {
    return {};
  }

  const now = Date.now();
  const leadDeadlineAt = ctx.scope.deadlineAt;
  const leadReserveMs = Math.max(0, ctx.scope.synthesisReserveMs);
  const subagentDeadlineAt = leadDeadlineAt - leadReserveMs;
  const subagentReserveMs = Math.min(
    leadReserveMs,
    SUBAGENT_SYNTHESIS_RESERVE_MS,
  );
  const usableMs = subagentDeadlineAt - now - subagentReserveMs;
  if (usableMs < SUBAGENT_MIN_RUNTIME_MS) {
    const remainingSeconds = Math.max(
      0,
      Math.ceil((leadDeadlineAt - now) / 1000),
    );
    const reserveSeconds = Math.ceil(leadReserveMs / 1000);
    return `Error: not enough remaining time to spawn sub-agents (${remainingSeconds}s left; ${reserveSeconds}s reserved for finalization). Investigate or finalize directly.`;
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
  ctx: ResearchCtx,
  fetchedUrls: string[],
): Array<{ source_id?: string; url: string; title?: string }> {
  const seen = new Set<string>();
  const sources: Array<{ source_id?: string; url: string; title?: string }> =
    [];
  for (const url of fetchedUrls) {
    const key = normalizeUrlForSource(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const document = ctx.store.sourceDocuments.get(key);
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

interface SubagentOutcome {
  summary: SubagentSummary;
  fetchedUrls: string[];
}

async function runSubagentTask(
  ctx: ResearchCtx,
  question: string,
  timing: SubagentTiming,
  perAgentMaxToolCalls: number,
): Promise<SubagentOutcome> {
  await using scope = ctx.scope.derive({
    query: question,
    depth: ctx.scope.depth + 1,
    deadlineAt: timing.deadlineAt,
    synthesisReserveMs: timing.synthesisReserveMs,
    compactionTriggerTokens: ctx.config.subagentCompactionTriggerTokens,
    compactionKeepTokens: ctx.config.subagentCompactionKeepTokens,
  });
  const subagentCtx: ResearchCtx = { ...ctx, scope };
  try {
    const run = await runResearchLoop({
      ctx: subagentCtx,
      query: question,
      maxToolCalls: perAgentMaxToolCalls,
      effort: ctx.config.subagentEffort,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
    });
    const findings = truncateFindings(run.markdown);
    ctx.scope.emit({
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
    ctx.deps.abort();
    return {
      summary: {
        task: question,
        error: err instanceof Error ? err.message : String(err),
      },
      fetchedUrls: [],
    };
  }
}

interface SubagentEntry {
  handle: string;
  task: string;
  status: "running" | "done" | "error";
  collected: boolean;
  promise: Promise<SubagentOutcome>;
}

function createSubagentScope(
  ctx: ResearchCtx,
  perAgentMaxToolCalls: number,
): SubagentScope {
  const registry = new Map<string, SubagentEntry>();
  const gate = createConcurrencyGate(ctx.config.maxConcurrentSubagents ?? 1);
  let counter = 0;

  const uncollected = (): SubagentEntry[] =>
    [...registry.values()].filter((entry) => !entry.collected);

  async function collect(entries: SubagentEntry[]): Promise<SubagentOutcome[]> {
    const outcomes = await Promise.all(
      entries.map((entry) =>
        entry.promise.catch(
          (err): SubagentOutcome => ({
            summary: {
              task: entry.task,
              error: err instanceof Error ? err.message : String(err),
            },
            fetchedUrls: [],
          }),
        ),
      ),
    );
    for (const entry of entries) entry.collected = true;
    return outcomes;
  }

  return {
    spawn(tasks) {
      if ((ctx.scope.depth ?? 0) >= (ctx.config.maxDelegationDepth ?? 0)) {
        return {
          handles: [],
          error:
            "Error: spawn is not available at this depth. Research this directly with search/fetch.",
        };
      }
      if (tokenBudgetExhaustedReason(ctx)) {
        return {
          handles: [],
          error:
            "Error: token budget exhausted. Investigate the most important angle directly and finalize.",
        };
      }
      const timing = subagentTiming(ctx);
      if (typeof timing === "string") {
        return { handles: [], error: timing };
      }
      const accepted = tasks.slice(0, SPAWN_MAX_TASKS);
      if (accepted.length === 0) {
        return {
          handles: [],
          error:
            "Error: spawn requires a non-empty `tasks` array of self-contained sub-questions.",
        };
      }
      ctx.scope.emit({ type: "delegation_started", tasks: accepted });
      const handles: Array<{ handle: string; task: string }> = [];
      for (const task of accepted) {
        counter += 1;
        const handle = `agent_${counter}`;
        ctx.scope.emit({ type: "subagent_started", task });
        const promise = gate.run(() =>
          runSubagentTask(ctx, task, timing, perAgentMaxToolCalls),
        );
        const entry: SubagentEntry = {
          handle,
          task,
          status: "running",
          collected: false,
          promise,
        };
        promise.then(
          (outcome) => {
            entry.status = outcome.summary.error ? "error" : "done";
          },
          () => {
            entry.status = "error";
          },
        );
        registry.set(handle, entry);
        handles.push({ handle, task });
      }
      return { handles };
    },

    async join(handles) {
      const targets =
        handles && handles.length > 0
          ? handles
              .map((handle) => registry.get(handle))
              .filter((entry): entry is SubagentEntry => Boolean(entry))
              .filter((entry) => !entry.collected)
          : uncollected();
      if (targets.length === 0) {
        return {
          summaries: [],
          fetchedUrls: [],
          error:
            "No outstanding sub-agents to join. Spawn sub-agents first, or write your report if you have enough evidence.",
        };
      }
      const outcomes = await collect(targets);
      return {
        summaries: outcomes.map((outcome) => outcome.summary),
        fetchedUrls: outcomes.flatMap((outcome) => outcome.fetchedUrls),
      };
    },

    async settle() {
      const targets = uncollected();
      if (targets.length === 0) return [];
      const outcomes = await collect(targets);
      return outcomes.flatMap((outcome) => outcome.fetchedUrls);
    },
  };
}

export async function runResearchLoop(opts: {
  ctx: ResearchCtx;
  query: string;
  maxToolCalls?: number;
  effort?: ResearchEffort;
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
  const subagents = createSubagentScope(ctx, SUBAGENT_MAX_TOOL_CALLS);

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
      resp = await ctx.deps.model.step({
        system: systemPrompt,
        tools,
        messages,
        maxTokens: ctx.config.maxOutputTokens ?? 2048,
        effort: opts.effort,
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
      const resp = await ctx.deps.model.step({
        system: systemPrompt,
        messages,
        maxTokens: ctx.config.maxOutputTokens ?? 2048,
        effort: opts.effort,
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
