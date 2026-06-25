import {
  generateText,
  stepCountIs,
  type ModelMessage,
} from "ai";
import type { BudgetGrant } from "./budget.js";
import type { AgentRole } from "./events.js";
import { stubToolResultWindow } from "./memory.js";
import { MODEL_CALL_MAX_RETRIES, totalFreshTokens, type ModelRole } from "./model.js";
import { currentFrame, withTraceFrame } from "./trace.js";
import { budgetStatusLine, type RunCtx } from "./state.js";
import {
  buildAgentTools,
  type AgentCtx,
  type ToolName,
} from "./tools.js";

const TASK_PREVIEW_CHARS = 300;

export const CONTEXT_BUDGET_STOP = "context budget reached";

export interface AgentSpec {
  role: AgentRole;
  modelRole: ModelRole;
  task: string;
  system: string;
  tools: ToolName[];
  grant: BudgetGrant;
  depth: number;
  parentId?: string | undefined;
  maxTurns?: number | undefined;
  maxOutputTokensPerStep?: number | undefined;
  maxContextTokens?: number | undefined;
  tokenCeiling?: number | undefined;
  captureMessages?: boolean | undefined;
  memoryCursor?: number | undefined;
  forceFirstTool?: ToolName | undefined;
  stopWhenSatisfied?: (() => boolean) | undefined;
}

export interface AgentResult {
  agentId: string;
  note: string;
  spentUSD: number;
  stopReason: string;
  messages?: ModelMessage[];
}

export async function runAgent(
  rctx: RunCtx,
  spec: AgentSpec,
): Promise<AgentResult> {
  const agentId = `agent_${rctx.agentSequence.next++}`;
  const actx: AgentCtx = {
    agentId,
    role: spec.role,
    grant: spec.grant,
    depth: spec.depth,
  };
  const toolNames = spec.tools;
  const tools = buildAgentTools(rctx, actx, toolNames);
  const model = rctx.bindModel(spec.modelRole, spec.grant);

  let governorReason: string | null = null;
  let lastText = "";

  const recorder = rctx.recorder;
  const parentSpanId = recorder ? currentFrame()?.parentSpanId : undefined;
  const agentSpanId = recorder?.mintSpanId();
  const agentStartedAt = recorder ? recorder.now() : 0;
  const logicalAgentId = agentId;
  const agentFrame = {
    agentId,
    logicalAgentId,
    role: spec.role,
    depth: spec.depth,
    site: spec.role,
    ...(agentSpanId ? { parentSpanId: agentSpanId } : {}),
  };

  const result = await withTraceFrame(recorder, agentFrame, () =>
    generateText({
    model,
    system: spec.system,
    prompt: spec.task,
    tools,
    maxRetries: MODEL_CALL_MAX_RETRIES,
    abortSignal: rctx.signal,
    ...(spec.maxOutputTokensPerStep
      ? { maxOutputTokens: spec.maxOutputTokensPerStep }
      : {}),
    stopWhen: [
      stepCountIs(spec.maxTurns ?? rctx.config.envelope.maxTurns),
      ({ steps }) => {
        if (spec.grant.floored()) {
          governorReason = "budget exhausted";
          return true;
        }
        if (
          spec.tokenCeiling !== undefined &&
          totalFreshTokens(rctx.usage) >= spec.tokenCeiling
        ) {
          governorReason = "token ceiling reached";
          return true;
        }
        const runReason = rctx.stopReason();
        if (runReason) {
          governorReason = runReason;
          return true;
        }
        if (spec.stopWhenSatisfied?.()) {
          governorReason = "ledger satisfied";
          return true;
        }
        if (spec.maxContextTokens !== undefined) {
          const inputTokens = steps.at(-1)?.usage.inputTokens;
          if (
            typeof inputTokens === "number" &&
            inputTokens >= spec.maxContextTokens
          ) {
            governorReason = CONTEXT_BUDGET_STOP;
            return true;
          }
        }
        return false;
      },
    ],
    prepareStep: ({ stepNumber, messages }) => {
      const memory =
        spec.memoryCursor !== undefined
          ? { messages: stubToolResultWindow(messages as ModelMessage[], spec.memoryCursor) }
          : {};
      if (spec.forceFirstTool && stepNumber === 0) {
        return {
          toolChoice: { type: "tool" as const, toolName: spec.forceFirstTool },
          ...memory,
        };
      }
      return memory;
    },
    onStepFinish: (step) => {
      if (step.text?.trim()) lastText = step.text.trim();
    },
    }),
  );

  const note = result.text.trim() || lastText;
  const stopReason =
    governorReason ??
    (result.finishReason === "stop" || result.finishReason === "tool-calls"
      ? "completed"
      : result.finishReason);

  if (recorder && agentSpanId) {
    recorder.recordAgentSpan({
      id: agentSpanId,
      ...(parentSpanId ? { parentId: parentSpanId } : {}),
      site: spec.role,
      agentId,
      logicalAgentId,
      role: spec.role,
      t0: agentStartedAt,
      t1: recorder.now(),
      costUSD: spec.grant.spentUSD(),
      status: rctx.signal?.aborted ? "aborted" : "ok",
      attrs: {
        depth: spec.depth,
        task: spec.task.slice(0, TASK_PREVIEW_CHARS),
        stopReason,
      },
    });
  }

  return {
    agentId,
    note,
    spentUSD: spec.grant.spentUSD(),
    stopReason,
    ...(spec.captureMessages ? { messages: result.response.messages } : {}),
  };
}

export function describeBudget(rctx: RunCtx): string {
  return budgetStatusLine(rctx);
}
