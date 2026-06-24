import {
  generateText,
  stepCountIs,
  tool,
  type FlexibleSchema,
  type ModelMessage,
} from "ai";
import type { BudgetGrant } from "./budget.js";
import { ECONOMY } from "./economy.js";
import type { AgentRole } from "./events.js";
import { stubToolResultWindow } from "./memory.js";
import { MODEL_CALL_MAX_RETRIES, type ModelRole } from "./model.js";
import { ROLE_CAPABILITIES } from "./roles.js";
import { currentFrame, withTraceFrame } from "./trace.js";
import { budgetStatusLine, type RunCtx } from "./state.js";
import {
  buildAgentTools,
  type AgentCtx,
  type ToolName,
} from "./tools.js";

const TASK_PREVIEW_CHARS = 300;
const NOTE_PREVIEW_CHARS = 600;
const FINAL_TOOL_VERDICT_RESERVE_USD = 0.01;

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
  captureMessages?: boolean | undefined;
  finalTool?: { name: string; inputSchema: FlexibleSchema } | undefined;
  memoryCursor?: number | undefined;
  forceFirstTool?: ToolName | undefined;
}

export interface AgentResult {
  agentId: string;
  note: string;
  claimsAdded: string[];
  spentUSD: number;
  stopReason: string;
  messages?: ModelMessage[];
  final?: unknown;
}

async function withResearchInFlight<T>(
  rctx: RunCtx,
  role: AgentRole,
  fn: () => Promise<T>,
): Promise<T> {
  if (role !== "research") return fn();
  rctx.counters.researchInFlight++;
  try {
    return await fn();
  } finally {
    rctx.counters.researchInFlight--;
  }
}

export async function runAgent(
  rctx: RunCtx,
  spec: AgentSpec,
): Promise<AgentResult> {
  const agentId = `agent_${rctx.agentSequence.next++}`;
  if (spec.depth > 0) {
    rctx.counters.agentsSpawned++;
    if (spec.role === "research") rctx.counters.researchSpawned++;
    rctx.counters.maxDepth = Math.max(rctx.counters.maxDepth, spec.depth);
    rctx.emit({
      type: "agent.spawned",
      agentId,
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
      role: spec.role,
      task: spec.task.slice(0, TASK_PREVIEW_CHARS),
      grantUSD: spec.grant.limitUSD,
      depth: spec.depth,
    });
  }

  const childClaims: string[] = [];
  const actx: AgentCtx = {
    agentId,
    role: spec.role,
    grant: spec.grant,
    depth: spec.depth,
    extractModel: rctx.bindModel("extract", spec.grant),
  };
  const toolNames = spec.tools;
  let finalValue: unknown;
  const tools = spec.finalTool
    ? {
        ...buildAgentTools(rctx, actx, toolNames),
        [spec.finalTool.name]: tool({
          description:
            "Record your final structured verdict for this task. Call this exactly once, when your investigation is complete.",
          inputSchema: spec.finalTool.inputSchema,
          execute: async (input: unknown) => {
            finalValue = input;
            return "Verdict recorded.";
          },
        }),
      }
    : buildAgentTools(rctx, actx, toolNames);
  const model = rctx.bindModel(spec.modelRole, spec.grant);

  let planEmitted = spec.role !== "orchestrator";
  let governorReason: string | null = null;
  let lastText = "";

  const recorder = rctx.recorder;
  const parentSpanId = recorder ? currentFrame()?.parentSpanId : undefined;
  const agentSpanId = recorder?.mintSpanId();
  const agentStartedAt = recorder ? recorder.now() : 0;
  const logicalAgentId = spec.role === "orchestrator" ? "lead" : agentId;
  const agentFrame = {
    agentId,
    logicalAgentId,
    role: spec.role,
    depth: spec.depth,
    site: spec.role,
    ...(agentSpanId ? { parentSpanId: agentSpanId } : {}),
  };

  const result = await withResearchInFlight(rctx, spec.role, () =>
    withTraceFrame(recorder, agentFrame, () =>
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
        if (spec.finalTool && finalValue !== undefined) return true;
        if (spec.grant.floored()) {
          governorReason = "budget exhausted";
          return true;
        }
        const runReason = rctx.stopReason();
        if (runReason) {
          governorReason = runReason;
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
      if (spec.finalTool && stepNumber >= 1) {
        const maxTurns = spec.maxTurns ?? rctx.config.envelope.maxTurns;
        const reserveVerdict =
          spec.grant.remainingUSD() <
          ECONOMY.grantFloorUSD + FINAL_TOOL_VERDICT_RESERVE_USD;
        if (stepNumber >= maxTurns - 1 || reserveVerdict) {
          return {
            toolChoice: { type: "tool" as const, toolName: spec.finalTool.name },
            ...memory,
          };
        }
      }
      return memory;
    },
    onStepFinish: (step) => {
      if (step.text?.trim()) lastText = step.text.trim();
      if (!planEmitted && step.text?.trim()) {
        planEmitted = true;
        rctx.emit({ type: "plan.updated", rationale: step.text.trim() });
      }
    },
    }),
    ),
  );

  if (ROLE_CAPABILITIES[spec.role].ledgerFlushOnReturn) {
    await rctx.ledger.flush(agentId);
  }

  const note = result.text.trim() || lastText;
  const ownClaims = rctx.ledger.claims
    .filter((claim) => claim.agentId === agentId && !claim.duplicateOf)
    .map((claim) => claim.id);
  const claimsAdded = [...ownClaims, ...childClaims];
  const stopReason =
    governorReason ??
    (result.finishReason === "stop" || result.finishReason === "tool-calls"
      ? "completed"
      : result.finishReason);

  if (spec.depth > 0) {
    rctx.emit({
      type: "agent.returned",
      agentId,
      role: spec.role,
      note: note.slice(0, NOTE_PREVIEW_CHARS),
      claimsAdded: claimsAdded.length,
      spentUSD: spec.grant.spentUSD(),
      stopReason,
    });
  }

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
        claimsAdded: claimsAdded.length,
      },
    });
  }

  return {
    agentId,
    note,
    claimsAdded,
    spentUSD: spec.grant.spentUSD(),
    stopReason,
    ...(spec.captureMessages ? { messages: result.response.messages } : {}),
    ...(finalValue !== undefined ? { final: finalValue } : {}),
  };
}

export function describeBudget(rctx: RunCtx): string {
  return budgetStatusLine(rctx);
}
