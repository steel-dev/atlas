import type { AgentRole } from "./events.js";

export interface RoleCapabilities {
  budgetLine: boolean;
  customTools: boolean;
}

export const ROLE_CAPABILITIES: Record<AgentRole, RoleCapabilities> = {
  gather: { budgetLine: true, customTools: true },
  write: { budgetLine: false, customTools: false },
};
