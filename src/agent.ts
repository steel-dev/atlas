import { generateText, stepCountIs, type ModelMessage } from "ai";
import type { BudgetGrant } from "./budget.js";
import { ECONOMY } from "./economy.js";
import { errorMessage } from "./errors.js";
import type { AgentRole } from "./events.js";
import { renderLedgerDigest } from "./ledger.js";
import { MODEL_CALL_MAX_RETRIES, type ModelRole } from "./model.js";
import { researchAgentSystem } from "./prompts.js";
import { ROLE_CAPABILITIES } from "./roles.js";
import { budgetStatusLine, type RunCtx } from "./state.js";
import {
  buildAgentTools,
  type AgentCtx,
  type SpawnInput,
  type ToolName,
} from "./tools.js";

const RESEARCH_TOOLS: ToolName[] = [
  "spawn",
  "search",
  "fetch",
  "read_source",
  "search_sources",
  "run_code",
  "ledger",
  "add_claim",
];

const TASK_PREVIEW_CHARS = 300;
const NOTE_PREVIEW_CHARS = 600;
const SPAWN_DIGEST_MAX_CLAIMS = 12;

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
}

export interface AgentResult {
  agentId: string;
  note: string;
  claimsAdded: string[];
  spentUSD: number;
  stopReason: string;
  messages?: ModelMessage[];
}

export async function runAgent(
  rctx: RunCtx,
  spec: AgentSpec,
): Promise<AgentResult> {
  const agentId = `agent_${rctx.agentSequence.next++}`;
  if (spec.depth > 0) {
    rctx.counters.agentsSpawned++;
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
    spawnsThisStep: { count: 0 },
    extractModel: rctx.bindModel("extract", spec.grant),
    spawn: (input) => executeSpawn(rctx, spec, actx, input, childClaims),
  };
  const allowSpawn =
    spec.tools.includes("spawn") &&
    spec.depth < rctx.config.envelope.depthCap &&
    ROLE_CAPABILITIES[spec.role].spawn;
  const toolNames = allowSpawn
    ? spec.tools
    : spec.tools.filter((name) => name !== "spawn");
  const tools = buildAgentTools(rctx, actx, toolNames);
  const model = rctx.bindModel(spec.modelRole, spec.grant);

  let planEmitted = spec.role !== "orchestrator";
  let governorReason: string | null = null;
  let lastText = "";

  const result = await generateText({
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
    prepareStep: () => {
      actx.spawnsThisStep.count = 0;
      return {};
    },
    onStepFinish: (step) => {
      if (step.text?.trim()) lastText = step.text.trim();
      if (!planEmitted && step.text?.trim()) {
        planEmitted = true;
        rctx.emit({ type: "plan.updated", rationale: step.text.trim() });
      }
    },
  });

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

  return {
    agentId,
    note,
    claimsAdded,
    spentUSD: spec.grant.spentUSD(),
    stopReason,
    ...(spec.captureMessages ? { messages: result.response.messages } : {}),
  };
}

async function executeSpawn(
  rctx: RunCtx,
  parentSpec: AgentSpec,
  parentActx: AgentCtx,
  input: SpawnInput,
  childClaims: string[],
): Promise<string> {
  const runReason = rctx.stopReason();
  if (runReason) {
    return `Spawn refused: ${runReason}. Stop calling tools and write your closing note.`;
  }
  const breadthCap = rctx.config.envelope.breadthCap;
  if (parentActx.spawnsThisStep.count >= breadthCap) {
    return `Spawn refused: per-turn spawn cap (${breadthCap}) reached. Integrate the results you have before spawning more.`;
  }
  parentActx.spawnsThisStep.count++;

  const task = input.task?.trim();
  if (!task) {
    return "Spawn refused: `task` must be a self-contained brief.";
  }
  const childDepth = parentSpec.depth + 1;
  if (childDepth > rctx.config.envelope.depthCap) {
    return `Spawn refused: depth cap (${rctx.config.envelope.depthCap}) reached. Do the work inline.`;
  }

  if (input.role === "verify") {
    return executeVerifySpawn(rctx, parentActx, input, childDepth);
  }

  const grant = parentActx.grant.grant({
    fraction: input.budget_fraction ?? ECONOMY.researchSpawnFraction,
  });
  if (!grant) {
    return "Spawn refused: insufficient budget remaining — do the work inline or finish.";
  }
  try {
    const child = await runAgent(rctx, {
      role: "research",
      modelRole: "research",
      task,
      system: researchAgentSystem(rctx.todayISO),
      tools: RESEARCH_TOOLS,
      grant,
      depth: childDepth,
      parentId: parentActx.agentId,
      maxTurns: rctx.config.envelope.maxSubagentTurns,
    });
    childClaims.push(...child.claimsAdded);
    const newClaims = child.claimsAdded
      .map((id) => rctx.ledger.byId(id))
      .filter(
        (claim): claim is NonNullable<typeof claim> =>
          claim !== undefined && !claim.duplicateOf,
      );
    return JSON.stringify(
      {
        note: child.note,
        stop_reason: child.stopReason,
        claims_added: child.claimsAdded.length,
        new_claims_digest: renderLedgerDigest(
          newClaims,
          SPAWN_DIGEST_MAX_CLAIMS,
        ),
        spent_usd: round2(child.spentUSD),
      },
      null,
      2,
    );
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return `Spawn failed: ${errorMessage(err)}`;
  } finally {
    grant.release();
  }
}

async function executeVerifySpawn(
  rctx: RunCtx,
  parentActx: AgentCtx,
  input: SpawnInput,
  childDepth: number,
): Promise<string> {
  const claimIds = [
    ...new Set(
      (input.claim_ids ?? [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (claimIds.length === 0) {
    return "Spawn refused: verify spawns require `claim_ids` from the ledger.";
  }
  const unknown = claimIds.filter((id) => !rctx.ledger.byId(id));
  if (unknown.length > 0) {
    return `Spawn refused: unknown claim ids: ${unknown.join(", ")}.`;
  }
  const grant = rctx.verifyReserve.grant({
    fraction: input.budget_fraction ?? ECONOMY.verifySpawn.fraction,
    minUSD: ECONOMY.verifySpawn.minUSD,
  });
  if (!grant) {
    return "Spawn refused: verification budget reserve is exhausted — finish and report.";
  }
  try {
    const outcome = await rctx.verifySpawn({
      claimIds,
      lenses: input.lenses,
      grant,
      parentId: parentActx.agentId,
      depth: childDepth,
    });
    return JSON.stringify(
      {
        note: outcome.note,
        verdicts: outcome.verdicts.map((verdict) => ({
          claim_id: verdict.claimId,
          status: verdict.status,
          votes: verdict.votes,
        })),
        spent_usd: round2(grant.spentUSD()),
      },
      null,
      2,
    );
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return `Spawn failed: ${errorMessage(err)}`;
  } finally {
    grant.release();
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function describeBudget(rctx: RunCtx): string {
  return budgetStatusLine(rctx);
}
