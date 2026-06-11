import type { Effort } from "./config.js";
import type { ClaimImportance, ClaimStatus } from "./ledger.js";

export type AgentRole = "orchestrator" | "research" | "verify" | "write";

export interface RunStats {
  effort: Effort;
  searches: number;
  sourcesFetched: number;
  sourcesFailed: number;
  claimsExtracted: number;
  claimsUnsupported: number;
  claimsVerified: number;
  claimsConfirmed: number;
  claimsScreened: number;
  claimsContested: number;
  claimsRefuted: number;
  citationsBound: number;
  citationsUnsupported: number;
  dupesDropped: number;
  agentsSpawned: number;
  maxDepth: number;
  singleAgent: boolean;
  tokens: Record<string, { input: number; output: number }>;
  costUSD: number;
  durationMs: number;
  budgetExhausted: boolean;
}

export type ResearchEvent =
  | {
      type: "run.started";
      runId: string;
      question: string;
      effort: Effort;
      budgetUSD: number;
    }
  | { type: "plan.updated"; rationale: string }
  | {
      type: "agent.spawned";
      agentId: string;
      parentId?: string;
      role: AgentRole;
      task: string;
      grantUSD: number;
      depth: number;
    }
  | {
      type: "agent.returned";
      agentId: string;
      role: AgentRole;
      note: string;
      claimsAdded: number;
      spentUSD: number;
      stopReason: string;
    }
  | {
      type: "search.completed";
      query: string;
      provider: string;
      results: number;
    }
  | { type: "search.failed"; query: string; error: string }
  | {
      type: "source.fetched";
      sourceId: string;
      url: string;
      title: string;
      via: string;
      chars: number;
      warnings?: string[];
    }
  | { type: "source.failed"; url: string; reason: string }
  | {
      type: "claim.extracted";
      claimId: string;
      sourceId: string;
      text: string;
      importance: ClaimImportance;
    }
  | {
      type: "extraction.completed";
      sourceId: string;
      url: string;
      count: number;
      unsupported: number;
      error?: string;
    }
  | {
      type: "claim.verified";
      claimId: string;
      status: ClaimStatus;
      votes: string;
    }
  | { type: "report.drafting" }
  | { type: "report.delta"; text: string }
  | {
      type: "citation.bound";
      claimId: string;
      sentence: string;
      ok: boolean;
    }
  | {
      type: "budget.warning";
      spentUSD: number;
      limitUSD: number;
      fraction: number;
    }
  | {
      type: "safety.flag";
      kind: "ssrf" | "url-entropy" | "injection" | "scheme";
      detail: string;
      url?: string;
    }
  | { type: "pricing.missing"; modelId: string; detail: string }
  | { type: "rate.limited"; retryAfterSeconds: number }
  | { type: "tool.event"; tool: string; data: unknown }
  | { type: "run.completed"; stats: RunStats }
  | { type: "run.error"; message: string; recoverable: boolean };

export type ResearchEventType = ResearchEvent["type"];

export type ResearchEventMap = {
  [E in ResearchEvent as E["type"]]: E;
};

export const EVENT_SCHEMA_VERSION = "2.0";
