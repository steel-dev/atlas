import { runAgent, type AgentResult } from "./agent.js";
import type { BudgetGrant } from "./budget.js";
import { orchestratorAnchor, orchestratorSystem } from "./prompts.js";
import type { RunCtx } from "./state.js";
import type { ToolName } from "./tools.js";

const ORCHESTRATOR_TOOLS: ToolName[] = [
  "spawn",
  "search",
  "fetch",
  "read_source",
  "search_sources",
  "run_code",
  "ledger",
  "add_claim",
];

export async function runOrchestrator(
  rctx: RunCtx,
  grant: BudgetGrant,
): Promise<AgentResult> {
  return runAgent(rctx, {
    role: "orchestrator",
    modelRole: "lead",
    task: orchestratorAnchor({
      question: rctx.question,
      effort: rctx.config.effort,
      budgetUSD: rctx.config.budgetUSD,
      depthCap: rctx.config.envelope.depthCap,
      breadthCap: rctx.config.envelope.breadthCap,
    }),
    system: orchestratorSystem(rctx.config.instructions),
    tools: ORCHESTRATOR_TOOLS,
    grant,
    depth: 0,
    maxTurns: rctx.config.envelope.maxTurns,
  });
}
