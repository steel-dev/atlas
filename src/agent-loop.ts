import type {
  ModelAdapter,
  ModelAssistantBlock,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  ModelToolResult,
  ProviderOptions,
} from "./model.js";

/** State handed to the governor before each model step. */
export interface AgentLoopState {
  /** 0-based index of the model step about to run. */
  readonly turn: number;
  /** Input tokens billed across the steps run so far this loop. */
  readonly inputTokens: number;
}

export type AgentLoopStopReason = "no_tool_calls" | "governor" | "max_turns";

export interface AgentLoopResult {
  /** The initial messages plus every assistant turn and tool-result turn. */
  messages: ModelMessage[];
  /** Content of the final model step (its text and/or tool calls). */
  lastContent: ModelAssistantBlock[];
  /** Number of tool-executing turns completed. */
  turns: number;
  /** Input tokens billed across all steps in this loop. */
  inputTokens: number;
  /** Why the loop stopped. */
  stopReason: AgentLoopStopReason;
}

export interface AgentLoopOptions {
  model: ModelAdapter;
  system: string;
  tools: ModelToolDefinition[];
  /** Initial messages. Copied, not mutated. */
  messages: ModelMessage[];
  /** Per-step output-token cap. */
  maxTokens: number;
  /** Hard backstop on model steps — a runaway guard, not the plan. */
  maxTurns: number;
  /** Run one turn's tool calls and return their results (matched by id). */
  executeTools: (calls: ModelToolCall[]) => Promise<ModelToolResult[]>;
  /** Checked before every step; return a reason string to stop the loop. */
  shouldStop?: (state: AgentLoopState) => string | null;
  signal?: AbortSignal;
  providerOptions?: ProviderOptions;
}

/**
 * A governed, tool-calling agent loop: the model steps, calls tools, sees their
 * results, and steps again until it stops calling tools (`no_tool_calls`), the
 * governor trips (`governor`), or the turn backstop is hit (`max_turns`). The
 * model — not a fixed step count — decides how deep to go; the bounds are
 * ceilings, not the itinerary. Callers inject tool dispatch and the governor,
 * so the same primitive can drive a leaf agent (a verifier voter) and, in time,
 * the lead gap loop.
 */
export async function runAgentLoop(
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const messages: ModelMessage[] = [...opts.messages];
  let inputTokens = 0;
  let turns = 0;
  let lastContent: ModelAssistantBlock[] = [];
  let stopReason: AgentLoopStopReason = "max_turns";

  for (let step = 0; step < opts.maxTurns; step++) {
    if (opts.shouldStop?.({ turn: step, inputTokens })) {
      stopReason = "governor";
      break;
    }
    const result = await opts.model.step({
      system: opts.system,
      tools: opts.tools,
      messages,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
    });
    inputTokens += result.inputTokens ?? 0;
    lastContent = result.content;
    messages.push({ role: "assistant", content: result.content });
    const toolCalls = result.content.filter(
      (block): block is ModelToolCall => block.type === "tool_call",
    );
    if (toolCalls.length === 0) {
      stopReason = "no_tool_calls";
      break;
    }
    const toolResults = await opts.executeTools(toolCalls);
    messages.push({ role: "user", content: toolResults });
    turns++;
  }

  return { messages, lastContent, turns, inputTokens, stopReason };
}
