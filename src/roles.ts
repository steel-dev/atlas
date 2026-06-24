import type { AgentRole } from "./events.js";

export interface RoleCapabilities {
  spawn: boolean;
  budgetLine: boolean;
  customTools: boolean;
  ledgerExtract: boolean;
  ledgerFlushOnReturn: boolean;
}

export const ROLE_CAPABILITIES: Record<AgentRole, RoleCapabilities> = {
  orchestrator: {
    spawn: true,
    budgetLine: true,
    customTools: true,
    ledgerExtract: true,
    ledgerFlushOnReturn: true,
  },
  research: {
    spawn: true,
    budgetLine: true,
    customTools: true,
    ledgerExtract: true,
    ledgerFlushOnReturn: true,
  },
  gather: {
    spawn: false,
    budgetLine: true,
    customTools: true,
    ledgerExtract: false,
    ledgerFlushOnReturn: false,
  },
  verify: {
    spawn: false,
    budgetLine: false,
    customTools: false,
    ledgerExtract: false,
    ledgerFlushOnReturn: false,
  },
  write: {
    spawn: false,
    budgetLine: false,
    customTools: false,
    ledgerExtract: false,
    ledgerFlushOnReturn: false,
  },
};
