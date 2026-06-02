import {
  createConcurrencyGate,
  tokenBudgetExhaustedReason,
  type ResearchCtx,
} from "./runtime.js";
import { normalizeUrlForSource } from "./url.js";
import {
  SPAWN_MAX_TASKS,
  type SubagentScope,
  type SubagentSummary,
} from "./tool-registry.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./tool-contract.js";
import type { ResearchLoopResult } from "./research-loop.js";

export const SUBAGENT_MAX_TOOL_CALLS = 20;
const SUBAGENT_MIN_RUNTIME_MS = 30_000;
const SUBAGENT_SYNTHESIS_RESERVE_MS = 45_000;
const SUBAGENT_FINDINGS_MAX_CHARS = 4_000;
const SUBAGENT_FALLBACK_MAX_SOURCES = 12;

export type SubagentRunner = (opts: {
  ctx: ResearchCtx;
  query: string;
  maxToolCalls?: number;
  systemPrompt?: string;
  suggestedParallelism?: number;
}) => Promise<ResearchLoopResult>;

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

function subagentFallbackFindings(
  ctx: ResearchCtx,
  run: ResearchLoopResult,
): string {
  const sources = subagentSources(ctx, run.fetchedUrls);
  if (sources.length === 0) return `(no findings; ${run.finishReason})`;
  const lines = sources
    .slice(0, SUBAGENT_FALLBACK_MAX_SOURCES)
    .map((source) => {
      const label = source.source_id ?? source.url;
      const title = source.title ? ` — ${source.title}` : "";
      return `- ${label}${title} (${source.url})`;
    });
  const overflow =
    sources.length > SUBAGENT_FALLBACK_MAX_SOURCES
      ? `\n- ...and ${sources.length - SUBAGENT_FALLBACK_MAX_SOURCES} more`
      : "";
  return [
    `(no synthesized report: ${run.finishReason})`,
    `${sources.length} source(s) were fetched and remain available via read_source — pull quotes from them directly:`,
    lines.join("\n") + overflow,
  ].join("\n");
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
  runLoop: SubagentRunner,
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
    const run = await runLoop({
      ctx: subagentCtx,
      query: question,
      maxToolCalls: perAgentMaxToolCalls,
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
        findings: findings || subagentFallbackFindings(ctx, run),
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

export function createSubagentScope(
  ctx: ResearchCtx,
  perAgentMaxToolCalls: number,
  runLoop: SubagentRunner,
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
          runSubagentTask(ctx, task, timing, perAgentMaxToolCalls, runLoop),
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
