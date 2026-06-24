import {
  exa as exaSearch,
  brave as braveSearch,
  tavily as tavilySearch,
} from "./providers/search.js";
import { exaContents, steel as steelFetch } from "./providers/fetch.js";
import { exaAgent } from "./providers/exa-agent.js";

export { Atlas } from "./atlas.js";
export type {
  AtlasConfig,
  Budget,
  ConcurrencyConfig,
  Effort,
  OutputSpec,
  ResearchOptions,
  SourceFilter,
  TraceMode,
} from "./config.js";
export type {
  ResearchClaims,
  ResearchResult,
  ResearchRun,
  ResumeOptions,
  RunStatus,
  SourceRecord,
} from "./run.js";
export type { Citation } from "./bind.js";
export type {
  AgentRole,
  ResearchEvent,
  ResearchEventMap,
  ResearchEventType,
  RunStats,
  StopReason,
} from "./events.js";
export { EVENT_SCHEMA_VERSION } from "./events.js";
export { TRACE_SCHEMA_VERSION } from "./trace.js";
export type {
  CriticalSpan,
  DigestAgent,
  DigestAnomaly,
  DigestPhase,
  RunDigest,
  RunTrace,
  Span,
  SpanKind,
  SpanStatus,
  TraceStep,
} from "./trace.js";
export type {
  ClaimConfidence,
  ClaimImportance,
  ClaimSourceQuality,
  ClaimStatus,
  ClaimVote,
  ResearchClaim,
} from "./ledger.js";
export type { ModelPricing, PricingTable } from "./budget.js";
export { DEFAULT_PRICING } from "./budget.js";
export type { SafetyPolicy } from "./safety.js";
export { researchTool } from "./custom-tools.js";
export type { ResearchTool, ToolContext } from "./custom-tools.js";
export { researcher } from "./researcher.js";
export type {
  Researcher,
  ResearchReport,
  ResearcherContext,
} from "./researcher.js";
export { nativeModelSearch } from "./providers/search.js";
export const exa = {
  search: exaSearch,
  contents: exaContents,
  agent: exaAgent,
};
export const brave = { search: braveSearch };
export const tavily = { search: tavilySearch };
export const steel = { fetch: steelFetch };
export type { ExaAgentOptions } from "./providers/exa-agent.js";
export type {
  SearchProvider,
  SearchQuery,
  SearchResult,
} from "./providers/search.js";
export { basicFetch } from "./providers/fetch.js";
export type {
  FetchAttempt,
  FetchProvider,
  FetchRequest,
  FetchedPage,
} from "./providers/fetch.js";
export { fileStore, loadTrace, memoryStore } from "./providers/store.js";
export type { JournalEntry, RunStore, RunSummary } from "./providers/store.js";
export type {
  CitedSource,
  FetchedSource,
  SourceDocument,
} from "./sources.js";
export {
  AtlasError,
  BudgetExceededError,
  ConfigError,
  ResumeError,
} from "./errors.js";
