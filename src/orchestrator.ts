import { CONTEXT_BUDGET_STOP, runAgent, type AgentResult } from "./agent.js";
import type { BudgetGrant } from "./budget.js";
import {
  orchestratorAnchor,
  orchestratorContinuationAnchor,
  orchestratorSystem,
} from "./prompts.js";
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

const LEAD_CONTEXT_TOKEN_BUDGET = 80_000;
const MAX_LEAD_SESSIONS = 8;
const CONTINUATION_DIGEST_CLAIMS = 60;

export interface OrchestratorOpts {
  gaps?: string[] | undefined;
  previousNote?: string | undefined;
}

export async function runOrchestrator(
  rctx: RunCtx,
  grant: BudgetGrant,
  opts: OrchestratorOpts = {},
): Promise<AgentResult> {
  const leadSpec = (task: string) => ({
    role: "orchestrator" as const,
    modelRole: "lead" as const,
    task,
    system: orchestratorSystem(rctx.config.instructions, rctx.todayISO),
    tools: ORCHESTRATOR_TOOLS,
    grant,
    depth: 0,
    maxTurns: rctx.config.envelope.maxTurns,
    maxContextTokens: LEAD_CONTEXT_TOKEN_BUDGET,
  });
  const anchor =
    opts.gaps && opts.gaps.length > 0
      ? orchestratorContinuationAnchor({
          question: rctx.question,
          reason: "coverage-gaps",
          previousNote: opts.previousNote,
          gaps: opts.gaps,
          digest: rctx.ledger.digest(CONTINUATION_DIGEST_CLAIMS),
          remainingUSD: grant.remainingUSD(),
        })
      : orchestratorAnchor({
          question: rctx.question,
          effort: rctx.config.effort,
          budgetUSD: rctx.config.budgetUSD,
          depthCap: rctx.config.envelope.depthCap,
          breadthCap: rctx.config.envelope.breadthCap,
        });

  const claimsAdded: string[] = [];
  let result = await runAgent(rctx, leadSpec(anchor));
  claimsAdded.push(...result.claimsAdded);

  let session = 1;
  while (
    result.stopReason === CONTEXT_BUDGET_STOP &&
    session < MAX_LEAD_SESSIONS &&
    !rctx.stopReason() &&
    !grant.floored()
  ) {
    session++;
    await rctx.ledger.settle();
    rctx.emit({ type: "lead.recontexted", session });
    result = await runAgent(
      rctx,
      leadSpec(
        orchestratorContinuationAnchor({
          question: rctx.question,
          reason: "context-recycled",
          previousNote: result.note,
          digest: rctx.ledger.digest(CONTINUATION_DIGEST_CLAIMS),
          remainingUSD: grant.remainingUSD(),
        }),
      ),
    );
    claimsAdded.push(...result.claimsAdded);
  }

  return { ...result, claimsAdded };
}
