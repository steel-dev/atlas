import {
  type ModelAssistantBlock,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolResult,
} from "./model.js";
import {
  stopRequestedReason,
  timeoutSynthesisReason,
  tokenBudgetExhaustedReason,
  type ResearchCtx,
} from "./runtime.js";
import {
  executeResearchTool,
  researchToolDefinitions,
  toolSpendsActionBudget,
  type ToolHandlerExtras,
} from "./tool-registry.js";
import { customToolDefinitions } from "./custom-tools.js";
import {
  EMPTY_GAP_NOTE_PROMPT,
  LEAD_SYSTEM_PROMPT,
  leadAnchorPrompt,
} from "./tool-contract.js";
import type { RecallOutcome } from "./recall.js";
import type { ResearchClaim } from "./claims.js";

const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
// Default re-anchor threshold: when the transcript passes this many estimated
// tokens, the lead drops it and rebuilds from the ledger digest. The default is
// safe for ~200k-context models; large-context models can raise it via
// RunOptions.reanchorTokens / ATLAS_REANCHOR_TOKENS so a long investigation keeps
// its working transcript instead of being rebuilt every 150k tokens.
const DEFAULT_REANCHOR_TRIGGER_TOKENS = 150_000;
const LEDGER_DIGEST_MAX_CLAIMS = 60;
const CHARS_PER_TOKEN = 4;

export interface GapLoopResult {
  gapsNote: string;
  toolCalls: number;
  totalToolExecutions: number;
  surveys: number;
  reanchors: number;
  finishReason: string;
}

function textFromContent(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function renderLedgerDigest(
  claims: ResearchClaim[],
  maxClaims = LEDGER_DIGEST_MAX_CLAIMS,
): string {
  const lines = claims
    .slice(0, maxClaims)
    .map(
      (claim) =>
        `[${claim.id}·${claim.importance}·${claim.sourceQuality}] ${claim.text} — ${shortHost(claim.url)} (${claim.sourceId})`,
    );
  if (claims.length > maxClaims) {
    lines.push(
      `…and ${claims.length - maxClaims} more claims (inspect their sources with search_sources/read_source)`,
    );
  }
  return lines.join("\n");
}

function estimateMessagesTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role === "user") {
      chars +=
        typeof message.content === "string"
          ? message.content.length
          : message.content.reduce(
              (sum, result) => sum + result.content.length,
              0,
            );
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          chars += block.text.length;
          break;
        case "thinking":
          chars += block.thinking.length;
          break;
        case "redacted_thinking":
          chars += block.data.length;
          break;
        case "tool_call":
          chars += block.name.length + JSON.stringify(block.input ?? {}).length;
          break;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function spendsActionBudget(tu: ModelToolCall): boolean {
  return toolSpendsActionBudget(tu.name);
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

export async function runGapLoop(opts: {
  ctx: ResearchCtx;
  question: string;
  recall: RecallOutcome;
  maxToolCalls: number;
}): Promise<GapLoopResult> {
  const { ctx, question, recall } = opts;
  const systemPrompt = ctx.config.instructions
    ? `${LEAD_SYSTEM_PROMPT}\n\n${ctx.config.instructions}`
    : LEAD_SYSTEM_PROMPT;
  const tools = [...researchToolDefinitions(), ...customToolDefinitions(ctx)];
  const maxToolCalls = opts.maxToolCalls;
  const maxTotalToolExecutions = maxToolCalls * 3;
  const extras: ToolHandlerExtras = {
    searchIndexRef: { next: recall.searchQueriesRun },
    surveyedGoals: [],
  };

  const buildAnchor = (reanchored: boolean): ModelMessage => ({
    role: "user",
    content: leadAnchorPrompt({
      question,
      strategy: recall.strategy,
      angles: recall.angles.map(({ label, query }) => ({ label, query })),
      ledgerDigest: renderLedgerDigest(ctx.store.claims.claims),
      claimCount: ctx.store.claims.claims.length,
      sourceCount: ctx.store.sourceDocuments.size,
      surveyedGoals: extras.surveyedGoals,
      reanchored,
    }),
  });

  const reanchorTrigger =
    ctx.config.reanchorTokens && ctx.config.reanchorTokens > 0
      ? ctx.config.reanchorTokens
      : DEFAULT_REANCHOR_TRIGGER_TOKENS;

  let messages: ModelMessage[] = [buildAnchor(false)];
  let toolCalls = 0;
  let totalToolExecutions = 0;
  let surveys = 0;
  let reanchors = 0;
  let gapsNote = "";
  let finishReason = "tool call budget exhausted";
  let nudgedEmptyResponse = false;

  while (
    toolCalls < maxToolCalls &&
    totalToolExecutions < maxTotalToolExecutions
  ) {
    ctx.deps.throwIfAborted();
    const breakReason =
      stopRequestedReason(ctx) ??
      timeoutSynthesisReason(ctx) ??
      tokenBudgetExhaustedReason(ctx);
    if (breakReason) {
      finishReason = breakReason;
      break;
    }

    if (estimateMessagesTokens(messages) > reanchorTrigger) {
      const tokensBefore = estimateMessagesTokens(messages);
      const droppedMessages = messages.length;
      messages = [buildAnchor(true)];
      reanchors++;
      ctx.scope.emit({
        type: "context_reanchored",
        tokensBefore,
        droppedMessages,
      });
    }

    let content: ModelAssistantBlock[];
    try {
      const resp = await ctx.deps.model.step({
        system: systemPrompt,
        tools,
        messages,
        maxTokens: ctx.config.maxOutputTokens ?? 2048,
        providerOptions: ctx.config.exploreProviderOptions,
        signal: ctx.deps.signal,
      });
      content = resp.content;
    } catch (err) {
      if (ctx.deps.signal?.aborted) throw err;
      finishReason = `api error: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    const toolUses = content.filter(
      (block): block is ModelToolCall => block.type === "tool_call",
    );
    if (toolUses.length === 0) {
      const text = textFromContent(content);
      if (text) {
        gapsNote = text;
        finishReason = "gaps assessed";
        break;
      }
      if (!nudgedEmptyResponse && content.length > 0) {
        nudgedEmptyResponse = true;
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: EMPTY_GAP_NOTE_PROMPT });
        continue;
      }
      finishReason = "empty response";
      break;
    }

    messages.push({ role: "assistant", content });

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
    toolCalls += activeToolUses.filter(spendsActionBudget).length;
    totalToolExecutions += activeToolUses.length;
    surveys += activeToolUses.filter((tu) => tu.name === "survey").length;

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.config.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu) => executeResearchTool(tu, ctx, extras),
    );
    const toolResults: ModelToolResult[] = [
      ...executions.map((execution) => execution.toolResult),
      ...skippedToolUses.map(
        ({ toolUse, reason }): ModelToolResult => ({
          type: "tool_result",
          tool_call_id: toolUse.id,
          content: `Tool not run: ${reason}. Stop calling tools and write your gap note.`,
          is_error: true,
        }),
      ),
    ];
    messages.push({ role: "user", content: toolResults });

    if (totalToolExecutions >= maxTotalToolExecutions) {
      finishReason = "tool execution safety budget exhausted";
      break;
    }
    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  return {
    gapsNote,
    toolCalls,
    totalToolExecutions,
    surveys,
    reanchors,
    finishReason,
  };
}
