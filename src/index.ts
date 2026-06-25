import {
  exa as exaSearch,
  brave as braveSearch,
  tavily as tavilySearch,
  nativeModelSearch,
} from "./providers/search.js";
import {
  exaContents,
  steel as steelFetch,
  basicFetch,
} from "./providers/fetch.js";
import { exaAgent } from "./providers/exa-agent.js";
import { perplexityAgent } from "./providers/perplexity-agent.js";
import { parallelAgent } from "./providers/parallel-agent.js";

export { Atlas } from "./atlas.js";
export type {
  AtlasConfig,
  Budget,
  ConcurrencyConfig,
  Effort,
  ResearchOptions,
  SourceFilter,
  TraceMode,
} from "./config.js";
export type { ModelRole } from "./model.js";
export type {
  ResearchResult,
  ResearchRun,
  ResumeOptions,
  RunStatus,
  SourceRecord,
} from "./run.js";
export type { StructuredResult } from "./structured.js";
export type {
  Citation,
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
export const exa = {
  search: exaSearch,
  contents: exaContents,
  agent: exaAgent,
};
export const brave = { search: braveSearch };
export const tavily = { search: tavilySearch };
export const native = { search: nativeModelSearch };
export const steel = { fetch: steelFetch };
export const basic = { fetch: basicFetch };
export const perplexity = { agent: perplexityAgent };
export const parallel = { agent: parallelAgent };
export type { ExaAgentOptions } from "./providers/exa-agent.js";
export type { PerplexityAgentOptions } from "./providers/perplexity-agent.js";
export type { ParallelAgentOptions } from "./providers/parallel-agent.js";
export type {
  BraveOptions,
  ExaOptions,
  NativeModelSearchOptions,
  SearchProvider,
  SearchQuery,
  SearchResult,
  TavilyOptions,
} from "./providers/search.js";
export type {
  FetchAttempt,
  FetchProvider,
  FetchRequest,
  FetchedPage,
  SteelOptions,
} from "./providers/fetch.js";
export { fileStore, loadTrace, memoryStore } from "./providers/store.js";
export type { JournalEntry, RunStore, RunSummary } from "./providers/store.js";
export type {
  SourceDiscoveredLink,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
export {
  AtlasError,
  BudgetExceededError,
  ConfigError,
  ResumeError,
} from "./errors.js";
