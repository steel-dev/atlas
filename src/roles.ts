import type { AgentRole } from "./events.js";

// What each agent role may do is declared here rather than scattered through
// the harness as role-string checks. Verify and write agents are read-only by
// construction: they cannot delegate, do not see the shared budget line (their
// spend is the caller's concern, not a decision input), and never receive
// user-supplied tools — fetched content they read must not gain new reach.
export interface RoleCapabilities {
  /** May delegate via the spawn tool (still subject to depth/breadth caps). */
  spawn: boolean;
  /** Tool results carry the shared-budget status line. */
  budgetLine: boolean;
  /** User-supplied research tools are exposed to this role. */
  customTools: boolean;
  /** Agent return waits for its queued claim extractions to land. */
  ledgerFlushOnReturn: boolean;
}

export const ROLE_CAPABILITIES: Record<AgentRole, RoleCapabilities> = {
  orchestrator: {
    spawn: true,
    budgetLine: true,
    customTools: true,
    ledgerFlushOnReturn: true,
  },
  research: {
    spawn: true,
    budgetLine: true,
    customTools: true,
    ledgerFlushOnReturn: true,
  },
  verify: {
    spawn: false,
    budgetLine: false,
    customTools: false,
    ledgerFlushOnReturn: false,
  },
  write: {
    spawn: false,
    budgetLine: false,
    customTools: false,
    ledgerFlushOnReturn: false,
  },
};
