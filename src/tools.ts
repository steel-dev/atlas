import {
  totalUsageTokens,
  type ModelAssistantBlock,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolResult,
} from "./model.js";
import type { ResearchEffort } from "./defaults.js";
import type { ResearchCtx } from "./runtime.js";
import { createSteelConcurrencyGate } from "./runtime.js";
import { maybeCompactResearchContext } from "./compaction.js";
import { errorMessage } from "./errors.js";
import { parseRetryAfterSeconds } from "./steel-runtime.js";
import {
  execFetch,
  normalizeFetchUrl,
  type FetchToolInput,
} from "./fetch-tool.js";
import {
  execDigestSource,
  execReadSource,
  execSearchSources,
  type DigestSourceToolInput,
  type ReadSourceToolInput,
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
  createAgentScope,
  createBudgetLedger,
  createResearchCaches,
  createSourceReservations,
  createSteelConcurrencyGate,
} from "./runtime.js";
export type {
  BudgetLedger,
  ResearchCaches,
  ResearchCtx,
  ResearchLoopEvent,
  SourceReservations,
  SteelConcurrencyGate,
} from "./runtime.js";

const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 3;
const SPAWN_MAX_TASKS = 4;
const SUBAGENT_MAX_TOOL_CALLS = 20;
const SPAWN_MIN_REMAINING_ACTION_CALLS = 2;
const SUBAGENT_MIN_RUNTIME_MS = 30_000;
const SUBAGENT_SYNTHESIS_RESERVE_MS = 45_000;
const SUBAGENT_FINDINGS_MAX_CHARS = 4_000;
const BUDGET_STATUS_REMAINING_RATIO = 0.3;
const FREE_TOOL_NAMES = new Set([
  "plan",
  "join",
  "read_source",
  "search_sources",
  "digest_source",
]);
const SUBAGENT_TOOL_NAMES = new Set(["spawn", "join"]);

function toolsForContext(ctx: ResearchCtx): ModelToolDefinition[] {
  if ((ctx.scope.depth ?? 0) >= (ctx.config.maxDelegationDepth ?? 0)) {
    return RESEARCH_TOOLS.filter((tool) => !SUBAGENT_TOOL_NAMES.has(tool.name));
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
  fetchedUrls?: string[];
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
  ctx: ResearchCtx;
}): string | null {
  const actionRemaining = opts.ctx.store.budget
    ? opts.ctx.store.budget.remainingActionCalls
    : Math.max(0, opts.maxActionToolCalls - opts.actionToolCalls);
  const totalRemaining = opts.ctx.store.budget
    ? opts.ctx.store.budget.remainingToolExecutions
    : Math.max(0, opts.maxTotalToolExecutions - opts.totalToolExecutions);
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

async function executeToolUse(
  tu: ModelToolCall,
  ctx: ResearchCtx,
  subagents: SubagentScope,
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
      ctx.deps.abort();
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
      ctx.deps.abort();
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

  if (tu.name === "read_source") {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: execReadSource((tu.input as ReadSourceToolInput) ?? {}, ctx),
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

  if (tu.name === "spawn") {
    const tasks = readSpawnTasks(tu.input);
    if (tasks.length === 0) {
      return textResult(
        tu.id,
        "spawn requires a non-empty `tasks` array of self-contained sub-questions.",
      );
    }
    const { handles, error } = subagents.spawn(tasks);
    if (error) return textResult(tu.id, error);
    return textResult(
      tu.id,
      JSON.stringify(
        {
          spawned: handles,
          note: "Sub-agents are running in the background. Call join (with these handles, or no arguments to collect all) to receive their cited findings before you finalize.",
        },
        null,
        2,
      ),
    );
  }

  if (tu.name === "join") {
    const { summaries, fetchedUrls, error } = await subagents.join(
      readJoinHandles(tu.input),
    );
    if (error) return textResult(tu.id, error);
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: JSON.stringify({ joined: summaries }, null, 2),
      },
      ...(fetchedUrls.length > 0 ? { fetchedUrls } : {}),
    };
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
        "search, fetch, search_sources, read_source, digest_source, browser_open, browser_cdp, browser_extract, spawn, join, plan.",
      is_error: true,
    },
  };
}

function textResult(id: string, content: string): ToolExecution {
  return {
    toolResult: { type: "tool_result", tool_call_id: id, content },
  };
}

function readSpawnTasks(input: unknown): string[] {
  const raw =
    input &&
    typeof input === "object" &&
    Array.isArray((input as { tasks?: unknown }).tasks)
      ? (input as { tasks: unknown[] }).tasks
      : [];
  const seen = new Set<string>();
  const tasks: string[] = [];
  for (const entry of raw) {
    const question =
      typeof entry === "string"
        ? entry.trim()
        : entry &&
            typeof entry === "object" &&
            typeof (entry as { question?: unknown }).question === "string"
          ? (entry as { question: string }).question.trim()
          : "";
    if (!question || seen.has(question)) continue;
    seen.add(question);
    tasks.push(question);
    if (tasks.length >= SPAWN_MAX_TASKS) break;
  }
  return tasks;
}

function readJoinHandles(input: unknown): string[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = (input as { handles?: unknown }).handles;
  if (!Array.isArray(raw)) return undefined;
  const handles = raw
    .map((handle) => (typeof handle === "string" ? handle.trim() : ""))
    .filter((handle) => handle.length > 0);
  return handles.length > 0 ? handles : undefined;
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
    const key = normalizeFetchUrl(url);
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

interface SubagentSummary {
  task: string;
  findings?: string;
  sources?: Array<{ source_id?: string; url: string; title?: string }>;
  tool_calls?: number;
  finish_reason?: string;
  error?: string;
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

interface SpawnResult {
  handles: Array<{ handle: string; task: string }>;
  error?: string;
}

interface JoinResult {
  summaries: SubagentSummary[];
  fetchedUrls: string[];
  error?: string;
}

interface SubagentScope {
  spawn(tasks: string[]): SpawnResult;
  join(handles: string[] | undefined): Promise<JoinResult>;
  settle(): Promise<string[]>;
}

function createSubagentScope(
  ctx: ResearchCtx,
  perAgentMaxToolCalls: number,
): SubagentScope {
  const registry = new Map<string, SubagentEntry>();
  let counter = 0;
  const gate =
    ctx.deps.subagentGate ??
    createSteelConcurrencyGate(
      ctx.config.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    );

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
      if (
        ctx.store.budget &&
        ctx.store.budget.remainingActionCalls < SPAWN_MIN_REMAINING_ACTION_CALLS
      ) {
        return {
          handles: [],
          error:
            "Error: not enough remaining tool budget to spawn sub-agents. Investigate the most important angle directly.",
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
  const tools = toolsForContext(ctx);
  const isSubagent = (ctx.scope.depth ?? 0) > 0;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxTotalToolExecutions = Math.max(maxToolCalls, maxToolCalls * 2);
  const subagents = createSubagentScope(ctx, SUBAGENT_MAX_TOOL_CALLS);

  if (!isSubagent) ctx.scope.emit({ type: "research_started" });

  const fetchedUrls: string[] = [];
  let toolCalls = 0;
  let totalToolExecutions = 0;
  let finishReason = "tool call budget exhausted";
  let markdown = "";
  let searchIndex = 0;

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

    await maybeCompactResearchContext({ ctx, messages });

    let resp: { content: ModelAssistantBlock[] };
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
      ctx.store.budget
        ? ctx.store.budget.remainingActionCalls
        : Number.POSITIVE_INFINITY,
    );
    let remainingTotalToolExecutions = Math.min(
      maxTotalToolExecutions - totalToolExecutions,
      ctx.store.budget
        ? ctx.store.budget.remainingToolExecutions
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
    ctx.store.budget?.consume(actionCallsThisStep, activeToolUses.length);

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.config.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) => executeToolUse(tu, ctx, subagents, searchIndexes[index]),
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
      (ctx.store.budget && ctx.store.budget.remainingToolExecutions <= 0)
    ) {
      finishReason = "tool execution safety budget exhausted";
      break;
    }

    if (
      toolCalls >= maxToolCalls ||
      (ctx.store.budget && ctx.store.budget.remainingActionCalls <= 0)
    ) {
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
  normalizeFetchUrl,
  parseRetryAfterSeconds,
  searchEnginesInFallbackOrder,
};
