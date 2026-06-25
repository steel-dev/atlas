import { exaAgent } from "./providers/exa-agent.js";
import {
  basicFetch,
  exaContents,
  steel as steelFetch,
} from "./providers/fetch.js";
import { parallelAgent } from "./providers/parallel-agent.js";
import { perplexityAgent } from "./providers/perplexity-agent.js";
import {
  brave as braveSearch,
  exa as exaSearch,
  nativeModelSearch,
  tavily as tavilySearch,
} from "./providers/search.js";

export { Atlas } from "./atlas.js";
export type { ModelPricing, PricingTable } from "./budget.js";
export { DEFAULT_PRICING } from "./budget.js";
export type {
  AtlasConfig,
  Budget,
  ConcurrencyConfig,
  Effort,
  ResearchOptions,
  SourceFilter,
  TraceMode,
} from "./config.js";
export type { ResearchTool, ToolContext } from "./custom-tools.js";
export { researchTool } from "./custom-tools.js";
export type {
  Citation,
  ResearchEvent,
  ResearchEventMap,
  ResearchEventType,
  RunStats,
  StopReason,
} from "./events.js";
export { EVENT_SCHEMA_VERSION } from "./events.js";
export type { ModelRole } from "./model.js";
export type {
  Researcher,
  ResearcherContext,
  ResearchReport,
} from "./researcher.js";
export { researcher } from "./researcher.js";
export type {
  ResearchResult,
  ResearchRun,
  ResumeOptions,
  RunStatus,
  SourceRecord,
} from "./run.js";
export type { SafetyPolicy } from "./safety.js";
export type { StructuredResult } from "./structured.js";
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
export { TRACE_SCHEMA_VERSION } from "./trace.js";
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
export type { AtlasErrorCode } from "./errors.js";
export { AtlasError } from "./errors.js";
export type {
  ArxivOptions,
  ClinicalTrialsOptions,
  EdgarOptions,
  OpenAlexOptions,
  PubmedOptions,
  SemanticScholarOptions,
  WikipediaOptions,
} from "./providers/domain/index.js";
export {
  arxiv,
  clinicaltrials,
  edgar,
  openalex,
  pubmed,
  semanticScholar,
  wikipedia,
} from "./providers/domain/index.js";
export type { ExaAgentOptions } from "./providers/exa-agent.js";
export type {
  FetchAttempt,
  FetchedPage,
  FetchProvider,
  FetchRequest,
  SteelOptions,
} from "./providers/fetch.js";
export type { ParallelAgentOptions } from "./providers/parallel-agent.js";
export type { PerplexityAgentOptions } from "./providers/perplexity-agent.js";
export type {
  BraveOptions,
  ExaOptions,
  NativeModelSearchOptions,
  SearchProvider,
  SearchQuery,
  SearchResult,
  TavilyOptions,
} from "./providers/search.js";
export type { JournalEntry, RunStore, RunSummary } from "./providers/store.js";
export { fileStore, loadTrace, memoryStore } from "./providers/store.js";
export type {
  SourceDiscoveredLink,
  SourceExtractionAttempt,
  SourceExtractionMetadata,
} from "./sources.js";
