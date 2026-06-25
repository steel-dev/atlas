import type { Effort } from "./config.js";

export type AgentRole = "gather" | "write";

export interface Citation {
  sourceId: string;
}

export type StopReason =
  | "completed"
  | "stopped"
  | "budget"
  | "tokens"
  | "timeout";

export interface RunStats {
  effort: Effort;
  searches: number;
  searchCacheHits: number;
  modelCacheHits: number;
  modelGatePeakWidth: number;
  sourcesFetched: number;
  sourcesFailed: number;
  citationsBound: number;
  citationsUnsupported: number;
  tokens: Record<string, { input: number; output: number }>;
  costUSD: number;
  durationMs: number;
  budgetExhausted: boolean;
  tokensExhausted: boolean;
  stopReason: StopReason;
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
  | { type: "report.drafting" }
  | { type: "report.delta"; text: string }
  | { type: "report.reset" }
  | { type: "report.completed"; report: string }
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
  | { type: "run_code.unavailable"; detail: string }
  | { type: "rate.limited"; retryAfterSeconds: number }
  | { type: "tool.event"; tool: string; data: unknown }
  | { type: "run.completed"; stats: RunStats }
  | { type: "run.error"; message: string; recoverable: boolean };

export type ResearchEventType = ResearchEvent["type"];

export type ResearchEventMap = {
  [E in ResearchEvent as E["type"]]: E;
};

export const EVENT_SCHEMA_VERSION = "3.3";
