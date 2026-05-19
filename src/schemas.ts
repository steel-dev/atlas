import { z } from "zod";
import { ENGINES } from "./search";
import { ErrorCodes } from "./utils/errors";

// ============================================================
// Shared
// ============================================================

export const JobStatusEnum = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const OpEnum = z.enum(["extract", "research", "crawl"]);

export const Progress = z.object({
  done: z.number().int(),
  total: z.number().int(),
});

export const ErrorCodeEnum = z.enum(
  Object.values(ErrorCodes) as [string, ...string[]],
);

export const ErrorEnvelope = z.object({
  success: z.literal(false),
  code: ErrorCodeEnum,
  error: z.string(),
  request_id: z.string(),
});

export const okEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    success: z.literal(true),
    data,
    request_id: z.string(),
  });

export const FORMATS = [
  "markdown",
  "html",
  "cleaned_html",
  "readability",
] as const;

// ============================================================
// /v1/search
// ============================================================

export const SearchRequest = z.object({
  query: z.string().min(1).max(2048),
  limit: z.number().int().min(1).max(50).default(10),
  engine: z.enum(ENGINES).default("ddg"),
  country: z.string().length(2).optional(),
  lang: z.string().min(2).max(5).optional(),
  use_proxy: z.boolean().default(false),
});

export const SearchResultItem = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  domain: z.string(),
  position: z.number().int().optional(),
});

export const SearchResponseData = z.object({
  query: z.string(),
  engine: z.enum(ENGINES),
  results_count: z.number().int(),
  results: z.array(SearchResultItem),
});

// ============================================================
// /v1/fetch
// ============================================================

export const FetchRequest = z.object({
  url: z.string().url(),
  format: z.enum(FORMATS).default("markdown"),
  use_proxy: z.boolean().default(false),
  delay: z.number().int().min(0).max(30_000).optional(),
});

export const FetchResponseData = z.object({
  url: z.string(),
  format: z.enum(FORMATS),
  status_code: z.number().int().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  content: z.string().nullable(),
  links_count: z.number().int(),
  metadata: z.record(z.string(), z.unknown()),
});

// ============================================================
// /v1/extract
// ============================================================

export const ExtractRequest = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  schema: z.record(z.string(), z.unknown()),
  prompt: z.string().max(2048).optional(),
  use_proxy: z.boolean().default(false),
});

export const JobSubmissionData = z.object({
  id: z.string(),
  op: OpEnum,
  status: JobStatusEnum,
  progress: Progress,
  url: z.string(),
  stream_url: z.string(),
});

export const Citation = z.object({
  quote: z.string(),
  field: z.string().optional(),
});

export const ExtractedSource = z.object({
  url: z.string(),
  title: z.string().nullable(),
  data: z.unknown().nullable(),
  citations: z.array(Citation),
  error: z.string().nullable(),
  fetched_at: z.number().nullable(),
});

export const ExtractResult = z.object({
  sources: z.array(ExtractedSource),
});

export const ExtractJobStatusData = z.object({
  id: z.string(),
  op: z.literal("extract"),
  status: JobStatusEnum,
  progress: Progress,
  error: z.string().optional(),
  created_at: z.number(),
  finished_at: z.number().optional(),
  result: ExtractResult.nullable().optional(),
});

// ============================================================
// /v1/research
// ============================================================

export const ResearchRequest = z.object({
  query: z.string().min(3).max(2048),
  max_sub_questions: z.number().int().min(1).max(5).default(3),
  max_results_per_question: z.number().int().min(1).max(10).default(3),
  max_sources: z.number().int().min(1).max(20).default(10),
  max_hops: z.number().int().min(0).max(5).default(1),
  verify_threshold: z.number().min(0).max(1).default(0.7),
  engine: z.enum(ENGINES).default("ddg"),
  use_proxy: z.boolean().default(false),
});

export const CitedSourceSchema = z.object({
  n: z.number().int(),
  url: z.string(),
  title: z.string(),
  summary: z.string(),
  key_excerpts: z.array(z.string()),
});

export const AssessmentRecordSchema = z.object({
  round: z.number().int(),
  sufficient: z.boolean(),
  gaps: z.array(z.string()),
  additional_queries: z.array(z.string()),
  reason: z.string().optional(),
});

export const ClaimVerificationSchema = z.object({
  claim: z.string(),
  source_n: z.number().int(),
  source_url: z.string().nullable(),
  source_title: z.string().nullable(),
  supported: z.boolean(),
  reason: z.string(),
});

export const VerificationSummarySchema = z.object({
  total: z.number().int(),
  supported: z.number().int(),
  unsupported: z.number().int(),
  pass_rate: z.number(),
});

export const ResearchResult = z.object({
  query: z.string(),
  brief: z.string(),
  sub_questions: z.array(z.string()),
  sources: z.array(CitedSourceSchema),
  markdown: z.string(),
  assessments: z.array(AssessmentRecordSchema),
  rounds: z.number().int(),
  attempts: z.number().int(),
  pass_rate_history: z.array(z.number()),
  verifications: z.array(ClaimVerificationSchema),
  verification_summary: VerificationSummarySchema,
});

export const ResearchJobStatusData = z.object({
  id: z.string(),
  op: z.literal("research"),
  status: JobStatusEnum,
  progress: Progress,
  error: z.string().optional(),
  created_at: z.number(),
  finished_at: z.number().optional(),
  result: ResearchResult.nullable().optional(),
});

// ============================================================
// /v1/crawl
// ============================================================

export const CrawlRequest = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(10_000).default(100),
  maxDepth: z.number().int().min(0).optional(),
  maxDiscoveryDepth: z.number().int().min(0).optional(),
  includePaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  crawlEntireDomain: z.boolean().default(false),
  allowSubdomains: z.boolean().default(false),
  allowExternalLinks: z.boolean().default(false),
  ignoreRobotsTxt: z.boolean().default(false),
  sitemap: z.enum(["skip", "include", "only"]).default("include"),
  deduplicateSimilarURLs: z.boolean().default(true),
  ignoreQueryParameters: z.boolean().default(false),
  regexOnFullURL: z.boolean().default(false),
  delay: z.number().nonnegative().optional(),
  use_proxy: z.boolean().default(false),
});

export const CrawlPage = z.object({
  id: z.string(),
  url: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  r2_key: z.string().nullable(),
  status_code: z.number().int().nullable(),
  chars: z.number().int().nullable(),
  error: z.string().nullable(),
  discovery_depth: z.number().int(),
  finished_at: z.number(),
});

export const CrawlResult = z.object({
  origin_url: z.string(),
  completed: z.number().int(),
  failed: z.number().int(),
  visited: z.number().int(),
  stopped_reason: z.string(),
});

export const CrawlSummary = z.object({
  completed: z.number().int(),
  failed: z.number().int(),
  visited_unique: z.number().int(),
  frontier_remaining: z.number().int(),
  pages_total: z.number().int(),
});

export const CrawlPagination = z.object({
  offset: z.number().int(),
  limit: z.number().int(),
  total_pages: z.number().int(),
  next_offset: z.number().int().nullable(),
});

export const CrawlJobStatusData = z.object({
  id: z.string(),
  op: z.literal("crawl"),
  status: JobStatusEnum,
  progress: Progress,
  error: z.string().optional(),
  created_at: z.number(),
  finished_at: z.number().optional(),
  result: CrawlResult.nullable().optional(),
  summary: CrawlSummary,
  pages: z.array(CrawlPage),
  pagination: CrawlPagination,
});
