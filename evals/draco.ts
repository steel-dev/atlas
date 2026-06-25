import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateObject,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../src/defaults.js";
import {
  Atlas,
  type AtlasConfig,
  type Effort,
  fileStore,
  type ResearchOptions,
  type ResearchResult,
  type ResearchRun,
  type TraceMode,
} from "../src/index.js";
import {
  arxiv,
  edgar,
  openalex,
  pubmed,
} from "../src/providers/domain/index.js";
import { defaultSearchProviders } from "../src/providers/search.js";
import {
  buildDiagnostics,
  type EvalDiagnostics,
  type EvalTraceEvent,
  formatCountMap,
  increment,
  isTransientResearchError,
  mapWithConcurrency,
  mean,
  median,
  progressLine,
  type RunMetrics,
  readEnv,
  stableHash,
  summarizeRun,
  traceEvent,
  writeJsonl,
} from "./lib.js";

type ModelProvider = "anthropic" | "openai";
type ResearchModel = AtlasConfig["model"];
type JudgeProvider = "google" | "anthropic" | "openai";
type Verdict = "MET" | "UNMET";
type GraderStrategy = "per-criterion" | "one-shot";

interface DracoCriterion {
  sectionId: string;
  sectionTitle: string;
  id: string;
  weight: number;
  requirement: string;
}

export interface DracoCase {
  id: string;
  domain: string;
  problem: string;
  rubricId: string;
  sections: { id: string; title: string }[];
  criteria: DracoCriterion[];
  raw: Record<string, unknown>;
}

export interface EvalOptions {
  casesPath: string;
  sample?: number;
  seed: string;
  caseIds: Set<string>;
  domains: Set<string>;
  stratify: "domain" | "none";
  outPath?: string;
  timeoutMs?: number;
  budgetUSD?: number;
  effort: Effort;
  provider?: ModelProvider;
  model?: string;
  leafModel?: string;
  grader: GraderStrategy;
  judgeProvider?: JudgeProvider;
  judgeModel?: string;
  judgeTimeoutMs: number;
  judgeConcurrency: number;
  gradeRuns: number;
  concurrency: number;
  retries: number;
  regrade?: string;
  dryRun: boolean;
  traceMode: TraceMode;
}

export interface JudgeSpec {
  provider: JudgeProvider;
  modelId: string;
  model: LanguageModel;
}

export interface CriterionReport {
  sectionId: string;
  id: string;
  requirement: string;
  weight: number;
  verdict: Verdict;
  reason: string;
  judgeError?: string;
  metVotes?: number;
  runs?: number;
}

interface SectionScore {
  id: string;
  title: string;
  criteria: number;
  rawScore: number;
  normalizedScore: number;
  passRate: number;
}

export interface RubricScore {
  criteria: number;
  gradedCriteria: number;
  rawScore: number;
  positiveWeight: number;
  negativeWeight: number;
  normalizedScore: number;
  passRate: number;
  normalizedScoreSD?: number;
  passRateSD?: number;
  gradingRuns?: number;
  sections: SectionScore[];
}

export interface EvalResult {
  type: "result";
  id: string;
  domain: string;
  problem: string;
  score?: RubricScore;
  report?: CriterionReport[];
  judgeErrors?: number;
  error?: string;
  capBound?: boolean;
  markdown?: string;
  latencyMs: number;
  trace: EvalTraceEvent[];
  diagnostics?: EvalDiagnostics;
  metrics?: RunMetrics;
  judgeUsage?: JudgeUsage;
}

export const DRACO_DATASET_REVISION =
  "ce076749809027649ebd331bcb70f42bf720d387";
export const DEFAULT_CASES_URL = `https://huggingface.co/datasets/perplexity-ai/draco/resolve/${DRACO_DATASET_REVISION}/test.jsonl`;
const DEFAULT_SEED = "atlas-draco-v1";
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_EFFORT: Effort = "deep";
export const DEFAULT_LEAF_MODEL = "claude-haiku-4-5";
const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;
const DEFAULT_JUDGE_CONCURRENCY = 8;
const JUDGE_MAX_RETRIES = 30;
const PER_CRITERION_JUDGE_MAX_TOKENS = 8_192;
const ONE_SHOT_JUDGE_MAX_TOKENS = 32_768;
const JUDGE_TEMPERATURE = 0;
const COVERAGE_FLOOR = 0.9;
const SECTION_ORDER = [
  "factual-accuracy",
  "breadth-and-depth-of-analysis",
  "presentation-quality",
  "citation-quality",
];

const PER_CRITERION_SYSTEM_PROMPT = `You are evaluating a response for a given query against a single criterion.

You will receive the response to evaluate, a single criterion to check, and a <criterion_type> field indicating if the criterion is positive or negative.

CRITERION TYPES:
The <criterion_type> field tells you whether this criterion describes something desirable (positive) or undesirable (negative). Your job is THE SAME for both types: determine if the thing described in the criterion is actually present in the response.

POSITIVE CRITERIA:
Positive criteria describe desired traits, requirements, or content that should be present.
- MET (criterion_status: "MET"): The response contains/satisfies the requirement
- UNMET (criterion_status: "UNMET"): The response does not contain/satisfy the requirement

NEGATIVE CRITERIA:
Negative criteria describe active errors or mistakes that the response is making.
- MET (criterion_status: "MET"): The response advocates, states, or recommends the problematic thing
- UNMET (criterion_status: "UNMET"): The response does NOT make this error, OR it mentions the thing only to warn against it or mention why it's wrong

Examples of what does NOT count as MET for negative criteria:
- "This is often misdiagnosed as X, but it's actually Y" → NOT stating it's X (UNMET)
- "Avoid doing X because..." → NOT recommending X (UNMET)
- "Unlike X, the correct approach is Y" → NOT advocating for X (UNMET)
- "A common mistake is thinking X" → NOT claiming X is correct (UNMET)

EVALUATION RULES:
- For numerical values: Check if they fall within specified ranges or match exactly as required.
- For factual claims: Verify the information is present and accurate, regardless of exact phrasing.
- For required elements: Confirm presence, counting precisely when numbers are specified.
- For exclusion requirements: Confirm that restricted content is absent.
- For length requirements: Carefully measure the number of words, characters, items, etc.
- Be strict about factual accuracy but flexible about wording.
- Accept semantically equivalent statements or implications where appropriate.
- Pay careful attention to negation, warnings, and contrasts.

CONDITIONAL VS UNCONDITIONAL ACTIONS (CRITICAL):
When a criterion requires an action to be done "immediately", "now", "as soon as possible", or unconditionally, you must distinguish:
- UNCONDITIONAL: "Give epinephrine now" or "Administer X immediately" → action IS being taken
- CONDITIONAL: "If Y occurs, give epinephrine" or "Start X if condition Z" → action is NOT being taken immediately; it's contingent on a future condition

If the criterion says something should happen "immediately" or without conditions, a conditional statement does NOT satisfy the criterion. Mark as UNMET.

Example:
- Criterion: "Administers alteplase immediately for acute ischemic stroke"
- Output: "If CT confirms no hemorrhage, consider alteplase" → UNMET (conditional, not immediate)
- Output: "Give alteplase now per acute stroke protocol" → MET (immediate, unconditional)

IMPLICIT VS EXPLICIT SATISFACTION:
Consider whether a criterion can be satisfied implicitly through context, tone, or logical implication, not just explicit statements:
- "States there is no location in China" can be MET by "Locations are only in United States and Canada"—if locations are ONLY in US and Canada, China is excluded; no need to mention China
- "Confirms the user is logged out" can be MET by "Session expired at 3:42 PM"—an expired session means the user is logged out, even without stating it directly

CRITERION STATUS:
"criterion_status" has *nothing* to do with quality or correctness. It only means:
- "MET": The thing described in the criterion IS present/occurring in the response
- "UNMET": The thing described in the criterion IS NOT present/occurring in the response

Your response must be valid JSON with this exact format:

{
"explanation": "Brief explanation of why the criterion is MET.",
"criterion_status": "MET"
}

Examples:

Positive criterion: "States Q4 2023 base margin as 17.2%"
Response: "The Q4 2023 base margin was 17.2% before adjustments."
{
"explanation": "The response states Q4 2023 base margin as 17.2%, as required.",
"criterion_status": "MET"
}

Negative criterion: "States that the patient has celiac disease"
Response: "This patient does not have celiac disease."
{
"explanation": "The response explicitly states the patient does NOT have celiac disease, so this error is not present.",
"criterion_status": "UNMET"
}

Positive criterion: "Administers epinephrine immediately for anaphylaxis"
Response: "If symptoms worsen, give epinephrine and call for help."
{
"explanation": "Epinephrine is mentioned only as a conditional action contingent on symptom worsening, not as an immediate intervention.",
"criterion_status": "UNMET"
}

Positive criterion: "States there is no location in China"
Response: "Locations are only in United States and Canada."
{
"explanation": "If locations are only in US and Canada, China is excluded. The response logically entails no China location without mentioning China.",
"criterion_status": "MET"
}

Return only raw JSON starting with {, no back-ticks, no 'json' prefix.`;

const ONE_SHOT_SYSTEM_PROMPT = `You are evaluating a response for a given query against a list of criteria.

You will receive the response to evaluate, and a numbered list of criteria to check (numbered 0, 1, 2, etc.). Each criterion is marked as POSITIVE or NEGATIVE. You must evaluate each criterion and return results with criterion_idx matching the indices in the list.

CRITERION TYPES:
Each criterion is marked as positive or negative. Your job is THE SAME for both types: determine if the thing described in the criterion is actually present in the response.

POSITIVE CRITERIA:
Positive criteria describe desired traits, requirements, or content that should be present.
- MET (criterion_status: "MET"): The response contains/satisfies the requirement
- UNMET (criterion_status: "UNMET"): The response does not contain/satisfy the requirement

NEGATIVE CRITERIA:
Negative criteria describe active errors or mistakes that the response is making.
- MET (criterion_status: "MET"): The response advocates, states, or recommends the problematic thing
- UNMET (criterion_status: "UNMET"): The response does NOT make this error, OR it mentions the thing only to warn against it or mention why it's wrong

Examples of what does NOT count as MET for negative criteria:
- "This is often misdiagnosed as X, but it's actually Y" → NOT stating it's X (UNMET)
- "Avoid doing X because..." → NOT recommending X (UNMET)
- "Unlike X, the correct approach is Y" → NOT advocating for X (UNMET)
- "A common mistake is thinking X" → NOT claiming X is correct (UNMET)

EVALUATION RULES:
- For numerical values: Check if they fall within specified ranges or match exactly as required.
- For factual claims: Verify the information is present and accurate, regardless of exact phrasing.
- For required elements: Confirm presence, counting precisely when numbers are specified.
- For exclusion requirements: Confirm that restricted content is absent.
- For length requirements: Carefully measure the number of words, characters, items, etc.
- Be strict about factual accuracy but flexible about wording.
- Accept semantically equivalent statements or implications where appropriate.
- Pay careful attention to negation, warnings, and contrasts.

CRITERION STATUS:
"criterion_status" has *nothing* to do with quality or correctness. It only means:
- "MET": The thing described in the criterion IS present/occurring in the response
- "UNMET": The thing described in the criterion IS NOT present/occurring in the response

Positive criterion: "States Q4 2023 base margin as 17.2%"
Response: "The Q4 2023 base margin was 17.2% before adjustments."
{
"explanation": "The response states Q4 2023 base margin as 17.2%, as required.",
"criterion_status": "MET"
}

Negative criterion: "States that the patient has diabetes"
Response: "This patient does not have diabetes."
{
"explanation": "The response explicitly states the patient does NOT have diabetes, so this error is not present.",
"criterion_status": "UNMET"
}

For each criterion, provide:
- The criterion_idx (0-indexed, matching the index from the criteria list above)
- An explanation containing a brief justification
- A criterion_status (MET or UNMET)

IMPORTANT: You must evaluate ALL criteria provided. The criterion_idx is 0-indexed (starts at 0)
and must match the index shown in the criteria list (0, 1, 2, etc.).
Do not skip any criteria.

Do NOT provide an overall score - only evaluate each criterion.

Respond ONLY with valid JSON in this exact format:
{
  "criteria_evaluations": [
    {
      "criterion_idx": 0,
      "explanation": "Brief explanation",
      "criterion_status": "MET"
    },
    ...
  ]
}`;

const PER_CRITERION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
      description:
        "Brief explanation of whether the criterion is present (MET) or absent (UNMET) in the response.",
    },
    criterion_status: {
      type: "string",
      enum: ["MET", "UNMET"],
      description:
        "Whether the criterion is present (MET) or absent (UNMET) in the response.",
    },
  },
  required: ["explanation", "criterion_status"],
  additionalProperties: false,
};

const ONE_SHOT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    criteria_evaluations: {
      type: "array",
      description: "List of evaluations for each criterion.",
      items: {
        type: "object",
        properties: {
          criterion_idx: {
            type: "integer",
            description: "The 0-based index of the criterion being evaluated.",
          },
          explanation: { type: "string" },
          criterion_status: { type: "string", enum: ["MET", "UNMET"] },
        },
        required: ["criterion_idx", "explanation", "criterion_status"],
        additionalProperties: false,
      },
    },
  },
  required: ["criteria_evaluations"],
  additionalProperties: false,
};

function usage(): string {
  return `Usage:
  npm run eval:draco -- [--cases <jsonl|url>] [options]

Options:
      --cases <file>          JSONL/JSON array/URL of DRACO cases (default: perplexity-ai/draco test.jsonl @ pinned revision)
      --sample N              Sample N tasks (default: all)
      --seed TEXT             Sampling seed (default: ${DEFAULT_SEED})
      --stratify MODE         domain | none (default: domain — even spread across domains)
      --case-id ID            Run one case ID; repeat or comma-separate
      --domain NAME           Restrict to domain(s); repeat or comma-separate
      --out <file>            Write manifest/results/summary JSONL
      --timeout N             Per-task research timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000}; 0 = unlimited, like DRACO)
      --budget N              Per-task research budget in USD (default: effort envelope)
      --trace MODE            off | spans | full — per-case trace to eval-runs/traces/<commit>/
      --effort LEVEL          Research effort: fast, balanced, deep, max (default: ${DEFAULT_EFFORT})
      --provider NAME         Research model provider: anthropic, openai
      --model NAME            Research (lead) model name — orchestration & synthesis
      --leaf-model NAME       Leaf model for claim extraction & verification (default: ${DEFAULT_LEAF_MODEL} on anthropic; lead model otherwise)
      --grader MODE           per-criterion | one-shot (default: per-criterion)
      --judge-provider P      Judge provider: google, anthropic, openai (default: anthropic; google uses a moving preview model)
      --judge-model MODEL     Judge model (default: claude-sonnet-4-6 for anthropic / gpt-5.2 / gemini-3.1-pro-preview)
      --judge-timeout N       Per-criterion judge timeout in seconds (default: ${DEFAULT_JUDGE_TIMEOUT_MS / 1000})
      --judge-concurrency N   Parallel judge calls per task (default: ${DEFAULT_JUDGE_CONCURRENCY})
      --concurrency N         Parallel tasks (default: 1)
      --retries N             Retry a task's research run on transient errors (default: 1)
      --regrade <file>        Re-judge a prior results JSONL (no research); reuses saved reports
      --dry-run               Print the selected tasks without calling APIs
      --help                  Show this help

Cases (perplexity-ai/draco JSONL): { id, domain, problem, answer } where answer is a
JSON-encoded rubric { id, sections:[{ id, title, criteria:[{ id, weight, requirement }] }] }.
`;
}

function fail(message: string): never {
  process.stderr.write(`eval:draco: ${message}\n`);
  process.exit(1);
}

function readValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function readPositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${name} must be a positive integer (got "${raw}")`);
  }
  return n;
}

function readPositiveNumber(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`${name} must be a positive number (got "${raw}")`);
  }
  return n;
}

function readNonNegativeInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

function readNonNegativeNumber(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    fail(`${name} must be a non-negative number (got "${raw}")`);
  }
  return n;
}

function readProvider(raw: string): ModelProvider {
  if (raw === "anthropic" || raw === "openai") return raw;
  fail(`--provider must be one of: anthropic, openai (got "${raw}")`);
}

function readJudgeProvider(raw: string): JudgeProvider {
  if (raw === "google" || raw === "anthropic" || raw === "openai") return raw;
  fail(
    `--judge-provider must be one of: google, anthropic, openai (got "${raw}")`,
  );
}

function readGrader(raw: string): GraderStrategy {
  if (raw === "per-criterion" || raw === "one-shot") return raw;
  fail(`--grader must be one of: per-criterion, one-shot (got "${raw}")`);
}

function readStratify(raw: string): "domain" | "none" {
  if (raw === "domain" || raw === "none") return raw;
  fail(`--stratify must be one of: domain, none (got "${raw}")`);
}

function readEffort(raw: string): Effort {
  if (raw === "fast" || raw === "balanced" || raw === "deep" || raw === "max") {
    return raw;
  }
  fail(`--effort must be one of: fast, balanced, deep, max (got "${raw}")`);
}

function readTrace(raw: string): TraceMode {
  if (raw === "off" || raw === "spans" || raw === "full") {
    return raw;
  }
  fail(`--trace must be one of: off, spans, full (got "${raw}")`);
}

export function buildEvalOptions(
  overrides: Partial<EvalOptions> = {},
): EvalOptions {
  return {
    casesPath: DEFAULT_CASES_URL,
    seed: DEFAULT_SEED,
    caseIds: new Set<string>(),
    domains: new Set<string>(),
    stratify: "domain",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    effort: DEFAULT_EFFORT,
    grader: "per-criterion",
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    judgeConcurrency: DEFAULT_JUDGE_CONCURRENCY,
    gradeRuns: 5,
    concurrency: 1,
    retries: 1,
    dryRun: false,
    traceMode: "off",
    ...overrides,
  };
}

function parseArgs(argv: string[]): EvalOptions {
  const opts = buildEvalOptions();
  const caseIds = opts.caseIds;
  const domains = opts.domains;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--cases") {
      opts.casesPath = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--sample") {
      opts.sample = readPositiveInt(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--seed") {
      opts.seed = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--stratify") {
      opts.stratify = readStratify(readValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === "--case-id") {
      for (const id of readValue(argv, i, arg).split(",")) {
        const trimmed = id.trim();
        if (trimmed) caseIds.add(trimmed);
      }
      i++;
      continue;
    }
    if (arg === "--domain") {
      for (const d of readValue(argv, i, arg).split(",")) {
        const trimmed = d.trim();
        if (trimmed) domains.add(trimmed.toLowerCase());
      }
      i++;
      continue;
    }
    if (arg === "--out") {
      opts.outPath = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--timeout") {
      const seconds = readNonNegativeNumber(readValue(argv, i, arg), arg);
      opts.timeoutMs = seconds === 0 ? undefined : Math.floor(seconds * 1000);
      i++;
      continue;
    }
    if (arg === "--budget") {
      opts.budgetUSD = readPositiveNumber(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--effort") {
      opts.effort = readEffort(readValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === "--provider") {
      opts.provider = readProvider(readValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === "--model") {
      opts.model = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--leaf-model") {
      opts.leafModel = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--grader") {
      opts.grader = readGrader(readValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === "--judge-provider") {
      opts.judgeProvider = readJudgeProvider(readValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === "--judge-model") {
      opts.judgeModel = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--judge-timeout") {
      opts.judgeTimeoutMs = Math.floor(
        readPositiveNumber(readValue(argv, i, arg), arg) * 1000,
      );
      i++;
      continue;
    }
    if (arg === "--judge-concurrency") {
      opts.judgeConcurrency = readPositiveInt(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--grade-runs") {
      opts.gradeRuns = readPositiveInt(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--concurrency") {
      opts.concurrency = readPositiveInt(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--retries") {
      opts.retries = readNonNegativeInt(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--regrade") {
      opts.regrade = readValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--trace") {
      opts.traceMode = readTrace(readValue(argv, i, arg));
      i++;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      opts.casesPath = arg;
      continue;
    }
    fail(`unknown option: ${arg}`);
  }

  return opts;
}

function huggingfaceRevision(pathOrUrl: string): string | null {
  const match = pathOrUrl.match(/huggingface\.co\/.+\/resolve\/([^/?#]+)\//);
  return match ? match[1] : null;
}

export function resolveResearchProvider(
  provider: ModelProvider | undefined,
): ModelProvider {
  const raw = provider ?? readEnv("ATLAS_PROVIDER");
  if (raw === "anthropic" || raw === "openai") return raw;
  if (raw) fail(`provider must be one of: anthropic, openai (got "${raw}")`);
  const hasOpenAI = Boolean(readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY"));
  const hasAnthropic = Boolean(
    readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
  );
  return hasOpenAI && !hasAnthropic ? "openai" : "anthropic";
}

export function resolveResearchModel(
  provider: ModelProvider,
  model: string | undefined,
): string {
  const raw =
    model ??
    readEnv(
      "ATLAS_MODEL",
      provider === "anthropic" ? "ATLAS_ANTHROPIC_MODEL" : "ATLAS_OPENAI_MODEL",
    );
  if (raw?.trim()) return raw.trim();
  return provider === "anthropic"
    ? DEFAULT_ANTHROPIC_MODEL
    : DEFAULT_OPENAI_MODEL;
}

export function effectiveLeafModel(opts: EvalOptions): string | undefined {
  const explicit = (opts.leafModel ?? readEnv("ATLAS_LEAF_MODEL"))?.trim();
  if (explicit) return explicit;
  return resolveResearchProvider(opts.provider) === "anthropic"
    ? DEFAULT_LEAF_MODEL
    : undefined;
}

function buildResearchModel(
  provider: ModelProvider,
  modelId: string,
): ResearchModel {
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) {
      fail(
        "ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY is required for provider=anthropic",
      );
    }
    return createAnthropic({ apiKey })(modelId);
  }
  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey) {
    fail(
      "OPENAI_API_KEY or ATLAS_OPENAI_API_KEY is required for provider=openai",
    );
  }
  return createOpenAI({ apiKey })(modelId);
}

export function buildAtlasConfig(opts: EvalOptions): AtlasConfig {
  const provider = resolveResearchProvider(opts.provider);
  const modelId = resolveResearchModel(provider, opts.model);
  const model = buildResearchModel(provider, modelId);
  const leafModelId = effectiveLeafModel(opts);
  const config: AtlasConfig =
    !leafModelId || leafModelId === modelId
      ? { model }
      : {
          model,
          models: {
            extract: buildResearchModel(provider, leafModelId),
            verify: buildResearchModel(provider, leafModelId),
          },
        };
  config.search = {
    web: defaultSearchProviders(model),
    academic: [openalex(), arxiv()],
    finance: [edgar()],
    medical: [pubmed()],
  };
  if (opts.traceMode === "full") {
    config.store = fileStore(join("eval-runs", "sources", currentCommit()));
  }
  return config;
}

function defaultJudgeModel(provider: JudgeProvider): string {
  if (provider === "google") return "gemini-3.1-pro-preview";
  if (provider === "anthropic") return "claude-sonnet-4-6";
  return "gpt-5.2";
}

export function buildJudgeSpec(opts: EvalOptions): JudgeSpec {
  const provider = opts.judgeProvider ?? "anthropic";
  const modelId = opts.judgeModel ?? defaultJudgeModel(provider);
  if (provider !== "google") {
    const researchProvider = resolveResearchProvider(opts.provider);
    if (
      provider === researchProvider &&
      modelId === resolveResearchModel(researchProvider, opts.model)
    ) {
      process.stderr.write(
        `warning: judge ${provider}/${modelId} is the model under test; self-grading inflates scores — pass --judge-model for an independent judge\n`,
      );
    }
  }
  if (provider === "google") {
    const apiKey = readEnv(
      "ATLAS_GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    );
    if (!apiKey) {
      throw new Error(
        "judge: set GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) for --judge-provider google, " +
          "or use --judge-provider anthropic|openai",
      );
    }
    return {
      provider,
      modelId,
      model: createGoogleGenerativeAI({ apiKey })(modelId),
    };
  }
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey)
      throw new Error(
        "judge: ANTHROPIC_API_KEY is required for --judge-provider anthropic",
      );
    return { provider, modelId, model: createAnthropic({ apiKey })(modelId) };
  }
  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey)
    throw new Error(
      "judge: OPENAI_API_KEY is required for --judge-provider openai",
    );
  return {
    provider,
    modelId,
    model: createOpenAI({ apiKey })(modelId),
  };
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function readFirstString(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = optionalString(raw[key]);
    if (value) return value;
  }
  return undefined;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function normalizeRubric(
  answer: unknown,
  caseId: string,
): {
  rubricId: string;
  sections: { id: string; title: string }[];
  criteria: DracoCriterion[];
} {
  let parsed: unknown = answer;
  if (typeof answer === "string") {
    try {
      parsed = JSON.parse(answer);
    } catch (err) {
      fail(
        `case "${caseId}": answer is not valid rubric JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    fail(`case "${caseId}": rubric is not an object`);
  }
  const rubric = parsed as Record<string, unknown>;
  const rawSections = rubric.sections;
  if (!Array.isArray(rawSections)) {
    fail(`case "${caseId}": rubric.sections is missing or not an array`);
  }
  const sections: { id: string; title: string }[] = [];
  const criteria: DracoCriterion[] = [];
  for (let s = 0; s < rawSections.length; s++) {
    const section = rawSections[s] as Record<string, unknown>;
    const sectionId = optionalString(section.id) ?? `section-${s}`;
    const sectionTitle =
      optionalString(section.title) ?? titleFromId(sectionId);
    sections.push({ id: sectionId, title: sectionTitle });
    const rawCriteria = section.criteria;
    if (!Array.isArray(rawCriteria)) continue;
    for (let c = 0; c < rawCriteria.length; c++) {
      const criterion = rawCriteria[c] as Record<string, unknown>;
      const weight = Number(criterion.weight);
      const requirement = optionalString(criterion.requirement);
      if (!Number.isFinite(weight) || !requirement) continue;
      criteria.push({
        sectionId,
        sectionTitle,
        id: optionalString(criterion.id) ?? `${sectionId}-${c}`,
        weight,
        requirement,
      });
    }
  }
  if (criteria.length === 0)
    fail(`case "${caseId}": rubric has no usable criteria`);
  return { rubricId: optionalString(rubric.id) ?? caseId, sections, criteria };
}

function normalizeCase(raw: unknown, index: number): DracoCase {
  if (typeof raw !== "object" || raw === null)
    fail(`case ${index}: not an object`);
  const record = raw as Record<string, unknown>;
  const id = optionalString(record.id) ?? `case-${index}`;
  const domain = optionalString(record.domain) ?? "Unknown";
  const problem = readFirstString(record, [
    "problem",
    "question",
    "query",
    "prompt",
    "input",
  ]);
  if (!problem) fail(`case "${id}": missing problem text`);
  const { rubricId, sections, criteria } = normalizeRubric(record.answer, id);
  return { id, domain, problem, rubricId, sections, criteria, raw: record };
}

async function readText(pathOrUrl: string): Promise<string> {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const response = await fetch(pathOrUrl);
    if (!response.ok) {
      fail(`failed to fetch cases URL "${pathOrUrl}": HTTP ${response.status}`);
    }
    return response.text();
  }
  try {
    return await readFile(pathOrUrl, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`failed to read cases file "${pathOrUrl}": ${message}`);
  }
}

export async function readCases(path: string): Promise<DracoCase[]> {
  const text = await readText(path);
  const trimmed = text.trim();
  if (!trimmed) fail(`cases file is empty: ${path}`);
  const rawCases = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => JSON.parse(line) as unknown);
  return rawCases.map(normalizeCase);
}

function sortBySeed(cases: DracoCase[], seed: string): DracoCase[] {
  return [...cases].sort((a, b) => {
    const aHash = stableHash(`${seed}\0${a.id}`);
    const bHash = stableHash(`${seed}\0${b.id}`);
    return aHash.localeCompare(bHash) || a.id.localeCompare(b.id);
  });
}

export function selectCases(
  cases: DracoCase[],
  opts: EvalOptions,
): DracoCase[] {
  let filtered = cases;
  if (opts.domains.size > 0) {
    filtered = filtered.filter((entry) =>
      opts.domains.has(entry.domain.toLowerCase()),
    );
  }
  if (opts.caseIds.size > 0) {
    filtered = filtered.filter((entry) => opts.caseIds.has(entry.id));
    if (filtered.length !== opts.caseIds.size) {
      const found = new Set(filtered.map((entry) => entry.id));
      const missing = [...opts.caseIds].filter((id) => !found.has(id));
      fail(`case ID(s) not found: ${missing.join(", ")}`);
    }
  }
  if (opts.sample === undefined || opts.sample >= filtered.length) {
    return filtered;
  }
  if (opts.stratify === "none") {
    return sortBySeed(filtered, opts.seed).slice(0, opts.sample);
  }
  const byDomain = new Map<string, DracoCase[]>();
  for (const entry of filtered) {
    const list = byDomain.get(entry.domain) ?? [];
    list.push(entry);
    byDomain.set(entry.domain, list);
  }
  for (const [domain, list] of byDomain) {
    byDomain.set(domain, sortBySeed(list, opts.seed));
  }
  const domainOrder = [...byDomain.keys()].sort((a, b) =>
    stableHash(`${opts.seed}\0domain\0${a}`).localeCompare(
      stableHash(`${opts.seed}\0domain\0${b}`),
    ),
  );
  const picked: DracoCase[] = [];
  for (let round = 0; picked.length < opts.sample; round++) {
    let advanced = false;
    for (const domain of domainOrder) {
      const entry = byDomain.get(domain)?.[round];
      if (!entry) continue;
      picked.push(entry);
      advanced = true;
      if (picked.length >= opts.sample) break;
    }
    if (!advanced) break;
  }
  return picked;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function scoreReports(reports: CriterionReport[]): {
  criteria: number;
  rawScore: number;
  positiveWeight: number;
  negativeWeight: number;
  normalizedScore: number;
  passRate: number;
} {
  const positiveWeight = reports.reduce(
    (sum, r) => sum + Math.max(0, r.weight),
    0,
  );
  const negativeWeight = reports.reduce(
    (sum, r) => sum + (r.weight < 0 ? Math.abs(r.weight) : 0),
    0,
  );
  const weighted = reports.reduce(
    (sum, r) => sum + (r.verdict === "MET" ? r.weight : 0),
    0,
  );
  let normalizedScore: number;
  if (positiveWeight > 0) normalizedScore = clamp01(weighted / positiveWeight);
  else if (negativeWeight > 0)
    normalizedScore = clamp01(1 + weighted / negativeWeight);
  else normalizedScore = 0;
  const passCount = reports.reduce(
    (sum, r) =>
      sum +
      ((r.weight > 0 && r.verdict === "MET") ||
      (r.weight < 0 && r.verdict === "UNMET")
        ? 1
        : 0),
    0,
  );
  return {
    criteria: reports.length,
    rawScore: weighted,
    positiveWeight,
    negativeWeight,
    normalizedScore,
    passRate: reports.length === 0 ? 0 : passCount / reports.length,
  };
}

export function buildScore(
  report: CriterionReport[],
  entry: DracoCase,
): RubricScore {
  const graded = report.filter((r) => !r.judgeError);
  const overall = scoreReports(graded);
  const titleById = new Map(entry.sections.map((s) => [s.id, s.title]));
  const presentIds = [
    ...SECTION_ORDER,
    ...entry.sections.map((s) => s.id),
  ].filter(
    (id, index, arr) =>
      arr.indexOf(id) === index && graded.some((r) => r.sectionId === id),
  );
  const sections: SectionScore[] = presentIds.map((id) => {
    const sectionReports = graded.filter((r) => r.sectionId === id);
    const score = scoreReports(sectionReports);
    return {
      id,
      title: titleById.get(id) ?? titleFromId(id),
      criteria: sectionReports.length,
      rawScore: score.rawScore,
      normalizedScore: score.normalizedScore,
      passRate: score.passRate,
    };
  });
  return {
    criteria: report.length,
    gradedCriteria: graded.length,
    rawScore: overall.rawScore,
    positiveWeight: overall.positiveWeight,
    negativeWeight: overall.negativeWeight,
    normalizedScore: overall.normalizedScore,
    passRate: overall.passRate,
    sections,
  };
}

function baseReport(
  criterion: DracoCriterion,
  verdict: Verdict,
  reason: string,
): CriterionReport {
  return {
    sectionId: criterion.sectionId,
    id: criterion.id,
    requirement: criterion.requirement,
    weight: criterion.weight,
    verdict,
    reason,
  };
}

export interface JudgeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  calls: number;
}

export function emptyJudgeUsage(): JudgeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    calls: 0,
  };
}

function addJudgeUsage(acc: JudgeUsage, u: LanguageModelUsage): void {
  const cacheRead =
    u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  acc.inputTokens += Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite);
  acc.outputTokens += u.outputTokens ?? 0;
  acc.cacheReadInputTokens += cacheRead;
  acc.cacheWriteInputTokens += cacheWrite;
  acc.calls += 1;
}

async function gradePerCriterion(
  judge: JudgeSpec,
  criterion: DracoCriterion,
  response: string,
  query: string,
  timeoutMs: number,
  usage?: JudgeUsage,
): Promise<CriterionReport> {
  const criterionType = criterion.weight < 0 ? "negative" : "positive";
  const prompt = `<criterion_type>
${criterionType}
</criterion_type>

<criterion>
${criterion.requirement}
</criterion>

<query>${query}</query>

<response>
${response}
</response>`;
  try {
    const { object, usage: u } = await generateObject({
      model: judge.model,
      system: PER_CRITERION_SYSTEM_PROMPT,
      prompt,
      schema: jsonSchema(PER_CRITERION_JSON_SCHEMA),
      temperature: JUDGE_TEMPERATURE,
      maxOutputTokens: PER_CRITERION_JUDGE_MAX_TOKENS,
      maxRetries: JUDGE_MAX_RETRIES,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    if (usage) addJudgeUsage(usage, u);
    const value = object as {
      explanation?: unknown;
      criterion_status?: unknown;
    };
    const verdict: Verdict =
      value?.criterion_status === "MET" ? "MET" : "UNMET";
    const reason =
      typeof value?.explanation === "string" ? value.explanation : "";
    return baseReport(criterion, verdict, reason);
  } catch (err) {
    return {
      ...baseReport(criterion, "UNMET", ""),
      judgeError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function gradeOneShot(
  judge: JudgeSpec,
  criteria: DracoCriterion[],
  response: string,
  query: string,
  timeoutMs: number,
  usage?: JudgeUsage,
): Promise<CriterionReport[]> {
  const criteriaText = criteria
    .map((criterion, index) => {
      const type =
        criterion.weight < 0
          ? "NEGATIVE (status MET if error IS present, UNMET if error is NOT present)"
          : "POSITIVE (status MET if requirement IS present, UNMET if requirement is NOT present)";
      return `${index}. [${type}] (weight: ${criterion.weight}) ${criterion.requirement}`;
    })
    .join("\n");
  const prompt = `Evaluate the response against the following criteria:
<criteria>
${criteriaText}
</criteria>

<query>${query}</query>

<response>
${response}
</response>

Provide your evaluation as JSON only.`;
  let evaluations: Array<Record<string, unknown>> = [];
  try {
    const { object, usage: u } = await generateObject({
      model: judge.model,
      system: ONE_SHOT_SYSTEM_PROMPT,
      prompt,
      schema: jsonSchema(ONE_SHOT_JSON_SCHEMA),
      temperature: JUDGE_TEMPERATURE,
      maxOutputTokens: ONE_SHOT_JUDGE_MAX_TOKENS,
      maxRetries: JUDGE_MAX_RETRIES,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    if (usage) addJudgeUsage(usage, u);
    const raw = (object as { criteria_evaluations?: unknown })
      .criteria_evaluations;
    if (Array.isArray(raw)) evaluations = raw as Array<Record<string, unknown>>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return criteria.map((criterion) => ({
      ...baseReport(criterion, "UNMET", ""),
      judgeError: message,
    }));
  }
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const evaluation of evaluations) {
    const idx = Number(evaluation.criterion_idx);
    if (Number.isInteger(idx)) byIndex.set(idx, evaluation);
  }
  return criteria.map((criterion, index) => {
    const evaluation = byIndex.get(index);
    if (!evaluation) {
      return {
        ...baseReport(criterion, "UNMET", "Evaluation not found in response"),
        judgeError: "missing_evaluation: criterion not returned by the judge",
      };
    }
    const verdict: Verdict =
      evaluation.criterion_status === "MET" ? "MET" : "UNMET";
    const reason =
      typeof evaluation.explanation === "string" ? evaluation.explanation : "";
    return baseReport(criterion, verdict, reason);
  });
}

export async function gradeRubric(opts: {
  judge: JudgeSpec;
  grader: GraderStrategy;
  criteria: DracoCriterion[];
  response: string;
  query: string;
  concurrency: number;
  timeoutMs: number;
  usage?: JudgeUsage;
  onProgress?: (done: number, total: number) => void;
}): Promise<CriterionReport[]> {
  const total = opts.criteria.length;
  if (opts.grader === "one-shot") {
    opts.onProgress?.(0, total);
    const report = await gradeOneShot(
      opts.judge,
      opts.criteria,
      opts.response,
      opts.query,
      opts.timeoutMs,
      opts.usage,
    );
    opts.onProgress?.(total, total);
    return report;
  }
  let done = 0;
  return mapWithConcurrency(
    opts.criteria,
    opts.concurrency,
    async (criterion) => {
      const report = await gradePerCriterion(
        opts.judge,
        criterion,
        opts.response,
        opts.query,
        opts.timeoutMs,
        opts.usage,
      );
      opts.onProgress?.(++done, total);
      return report;
    },
  );
}

export function buildResearchRunOptions(opts: EvalOptions): ResearchOptions {
  const budget = {
    ...(opts.budgetUSD !== undefined ? { maxUSD: opts.budgetUSD } : {}),
    ...(opts.timeoutMs !== undefined ? { maxDurationMs: opts.timeoutMs } : {}),
  };
  return {
    effort: opts.effort,
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    ...(opts.traceMode !== "off" ? { trace: opts.traceMode } : {}),
  };
}

function currentCommit(): string {
  try {
    return (
      execSync("git rev-parse --short HEAD", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "nocommit"
    );
  } catch {
    return "nocommit";
  }
}

function writeEvalTrace(run: ResearchRun, entry: DracoCase): void {
  const trace = run.trace();
  if (!trace) return;
  const commit = currentCommit();
  const dir = join("eval-runs", "traces", commit);
  mkdirSync(dir, { recursive: true });
  const meta = {
    runId: run.id,
    commit,
    caseId: entry.id,
    domain: entry.domain,
    problem: entry.problem,
  };
  writeFileSync(
    join(dir, `${entry.id}.trace.json`),
    JSON.stringify({ ...meta, spans: trace.spans, steps: trace.steps }),
  );
  writeFileSync(
    join(dir, `${entry.id}.digest.json`),
    JSON.stringify({ ...meta, digest: trace.digest ?? null }, null, 2),
  );
  process.stderr.write(
    `eval:draco: ${entry.id}: trace ${trace.mode} → ${join(dir, `${entry.id}.trace.json`)}\n`,
  );
}

async function runResearch(
  entry: DracoCase,
  opts: EvalOptions,
  trace: EvalTraceEvent[],
  started: number,
): Promise<ResearchResult> {
  const attempts = opts.retries + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const atlas = new Atlas(buildAtlasConfig(opts));
      const run = atlas.start(entry.problem, buildResearchRunOptions(opts));
      for await (const event of run.events()) {
        const traced = traceEvent(event, started);
        if (traced) trace.push(traced);
        const line = progressLine(entry.id, event);
        if (line) process.stderr.write(`eval:draco: ${line}\n`);
      }
      const result = await run.result();
      if (opts.traceMode !== "off") writeEvalTrace(run, entry);
      return result;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < attempts && isTransientResearchError(message)) {
        const backoffMs = Math.min(30_000, 5_000 * attempt);
        process.stderr.write(
          `eval:draco: ${entry.id}: research attempt ${attempt}/${attempts} failed (${message.slice(0, 80)}); retrying in ${Math.round(backoffMs / 1000)}s\n`,
        );
        await new Promise((delay) => setTimeout(delay, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

export function aggregateGrading(
  reports: CriterionReport[][],
  entry: DracoCase,
): { report: CriterionReport[]; score?: RubricScore } {
  const runs = reports.length;
  if (runs <= 1) {
    const report = reports[0] ?? [];
    const judgeErrors = report.filter((r) => r.judgeError).length;
    const score =
      judgeErrors < report.length ? buildScore(report, entry) : undefined;
    return { report, score };
  }
  const perRun = reports.map((r) => buildScore(r, entry));
  const aggReport: CriterionReport[] = entry.criteria.map((_criterion, j) => {
    const cells = reports.map((r) => r[j]).filter(Boolean);
    const base = cells[0];
    const metVotes = cells.filter((c) => c.verdict === "MET").length;
    const verdict: Verdict = metVotes * 2 >= cells.length ? "MET" : "UNMET";
    const reason =
      cells.find((c) => c.verdict === verdict && c.reason)?.reason ??
      base.reason;
    const allErrored = cells.every((c) => c.judgeError);
    return {
      sectionId: base.sectionId,
      id: base.id,
      requirement: base.requirement,
      weight: base.weight,
      verdict,
      reason,
      metVotes,
      runs: cells.length,
      ...(allErrored ? { judgeError: base.judgeError } : {}),
    };
  });
  const judgeErrors = aggReport.filter((r) => r.judgeError).length;
  if (judgeErrors >= aggReport.length) return { report: aggReport };
  const baseScore = buildScore(aggReport, entry);
  const sections = baseScore.sections.map((sec) => {
    const vals = perRun
      .map((s) => s.sections.find((x) => x.id === sec.id))
      .filter((x): x is SectionScore => Boolean(x));
    return {
      ...sec,
      normalizedScore: mean(vals.map((v) => v.normalizedScore)),
      passRate: mean(vals.map((v) => v.passRate)),
    };
  });
  const score: RubricScore = {
    ...baseScore,
    normalizedScore: mean(perRun.map((s) => s.normalizedScore)),
    passRate: mean(perRun.map((s) => s.passRate)),
    normalizedScoreSD: std(perRun.map((s) => s.normalizedScore)),
    passRateSD: std(perRun.map((s) => s.passRate)),
    gradingRuns: runs,
    sections,
  };
  return { report: aggReport, score };
}

export async function gradeResearch(
  entry: DracoCase,
  opts: EvalOptions,
  judge: JudgeSpec,
  result: ResearchResult,
  trace: EvalTraceEvent[],
  startedAt: number,
  onGradeProgress?: (done: number, total: number) => void,
): Promise<EvalResult> {
  const runs = Math.max(1, opts.gradeRuns ?? 1);
  const total = entry.criteria.length * runs;
  const judgeUsage = emptyJudgeUsage();
  const reports: CriterionReport[][] = [];
  for (let run = 0; run < runs; run++) {
    const offset = run * entry.criteria.length;
    const rep = await gradeRubric({
      judge,
      grader: opts.grader,
      criteria: entry.criteria,
      response: result.report,
      query: entry.problem,
      concurrency: opts.judgeConcurrency,
      timeoutMs: opts.judgeTimeoutMs,
      usage: judgeUsage,
      onProgress: (done) => onGradeProgress?.(offset + done, total),
    });
    reports.push(rep);
  }
  const { report, score } = aggregateGrading(reports, entry);
  const judgeErrors = report.filter((r) => r.judgeError).length;
  const latencyMs = Date.now() - startedAt;
  const metrics = summarizeRun(result);
  return {
    type: "result",
    id: entry.id,
    domain: entry.domain,
    problem: entry.problem,
    ...(score ? { score } : {}),
    report,
    ...(judgeErrors ? { judgeErrors } : {}),
    capBound: result.stats.budgetExhausted,
    markdown: result.report,
    latencyMs,
    trace,
    diagnostics: buildDiagnostics({ trace, latencyMs, metrics }),
    metrics,
    judgeUsage,
  };
}

async function runCase(
  entry: DracoCase,
  opts: EvalOptions,
  judge: JudgeSpec,
): Promise<EvalResult> {
  const started = Date.now();
  const trace: EvalTraceEvent[] = [];
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    const timeoutSeconds =
      opts.timeoutMs === undefined ? "none" : Math.round(opts.timeoutMs / 1000);
    process.stderr.write(
      `eval:draco: ${entry.id} still running (${elapsedSeconds}s elapsed, timeout=${timeoutSeconds}s)\n`,
    );
  }, 30_000);
  try {
    const result = await runResearch(entry, opts, trace, started);
    clearInterval(heartbeat);
    process.stderr.write(
      `eval:draco: ${entry.id}: judging ${entry.criteria.length} criteria (${opts.grader}, ${judge.provider}/${judge.modelId})\n`,
    );
    const evalResult = await gradeResearch(
      entry,
      opts,
      judge,
      result,
      trace,
      started,
    );
    const score = evalResult.score;
    if (score) {
      process.stderr.write(
        `eval:draco: ${entry.id} [${entry.domain}]: score ${(score.normalizedScore * 100).toFixed(1)}% ` +
          `pass ${(score.passRate * 100).toFixed(1)}% (${score.gradedCriteria}/${score.criteria} criteria graded${
            evalResult.judgeErrors
              ? `, ${evalResult.judgeErrors} judge error(s)`
              : ""
          })\n`,
      );
    } else {
      process.stderr.write(
        `eval:draco: ${entry.id} [${entry.domain}]: UNGRADED — all ${evalResult.report?.length ?? 0} criteria errored on the judge\n`,
      );
    }
    return evalResult;
  } catch (err) {
    clearInterval(heartbeat);
    const latencyMs = Date.now() - started;
    return {
      type: "result",
      id: entry.id,
      domain: entry.domain,
      problem: entry.problem,
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
      trace,
      diagnostics: buildDiagnostics({ trace, latencyMs }),
    };
  }
}

function summarizeFetchHealth(results: EvalResult[]) {
  const fetchedByMethod: Record<string, number> = {};
  let fetched = 0;
  let rejected = 0;
  let blockedOrThin = 0;
  for (const result of results) {
    const fetch = result.diagnostics?.fetch;
    if (!fetch) continue;
    fetched += fetch.fetched;
    rejected += fetch.rejected;
    blockedOrThin += fetch.blockedOrThinSources;
    for (const [method, count] of Object.entries(fetch.fetchedByMethod)) {
      fetchedByMethod[method] = (fetchedByMethod[method] ?? 0) + count;
    }
  }
  return { fetched, rejected, blockedOrThin, fetchedByMethod };
}

function summarizeClaimHealth(results: EvalResult[]) {
  return results.reduce(
    (summary, result) => {
      const claims = result.diagnostics?.claims;
      if (!claims) return summary;
      summary.extracted += claims.extracted;
      summary.unsupported += claims.unsupported;
      summary.verified += claims.verified;
      summary.confirmed += claims.confirmed;
      summary.contested += claims.contested;
      summary.refuted += claims.refuted;
      summary.unverified += claims.unverified;
      return summary;
    },
    {
      extracted: 0,
      unsupported: 0,
      verified: 0,
      confirmed: 0,
      contested: 0,
      refuted: 0,
      unverified: 0,
    },
  );
}

function summarize(results: EvalResult[]) {
  const completed = results.filter((result) => !result.error);
  const scored = results.filter(
    (result): result is EvalResult & { score: RubricScore } =>
      result.score !== undefined,
  );
  const byDomain = new Map<string, RubricScore[]>();
  for (const result of scored) {
    const list = byDomain.get(result.domain) ?? [];
    list.push(result.score);
    byDomain.set(result.domain, list);
  }
  const domains = [...byDomain.entries()]
    .map(([domain, list]) => ({
      domain,
      tasks: list.length,
      normalizedScore: mean(list.map((s) => s.normalizedScore)),
      passRate: mean(list.map((s) => s.passRate)),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  const sectionIds = [
    ...SECTION_ORDER,
    ...scored.flatMap((result) => result.score.sections.map((s) => s.id)),
  ].filter((id, index, arr) => arr.indexOf(id) === index);
  const sections = sectionIds
    .map((id) => {
      const sectionScores = scored
        .map((result) => result.score.sections.find((s) => s.id === id))
        .filter((s): s is SectionScore => s !== undefined);
      return {
        id,
        title: sectionScores[0]?.title ?? titleFromId(id),
        tasks: sectionScores.length,
        normalizedScore: mean(sectionScores.map((s) => s.normalizedScore)),
        passRate: mean(sectionScores.map((s) => s.passRate)),
      };
    })
    .filter((section) => section.tasks > 0);
  const totalCostUSD = completed.reduce(
    (sum, result) => sum + (result.metrics?.costUSD ?? 0),
    0,
  );
  const totalAgentsSpawned = completed.reduce(
    (sum, result) => sum + (result.metrics?.agentsSpawned ?? 0),
    0,
  );
  const totalInputTokens = completed.reduce(
    (sum, result) => sum + (result.metrics?.inputTokens ?? 0),
    0,
  );
  const totalOutputTokens = completed.reduce(
    (sum, result) => sum + (result.metrics?.outputTokens ?? 0),
    0,
  );
  const totalLatencyMs = completed.reduce(
    (sum, result) => sum + result.latencyMs,
    0,
  );
  const gradedCriteria = scored.reduce(
    (sum, result) => sum + result.score.gradedCriteria,
    0,
  );
  const totalCriteria = scored.reduce(
    (sum, result) => sum + result.score.criteria,
    0,
  );
  const coverage = totalCriteria === 0 ? 1 : gradedCriteria / totalCriteria;
  const capBound = completed.filter((result) => result.capBound).length;
  return {
    type: "summary" as const,
    total: results.length,
    completed: completed.length,
    scored: scored.length,
    ungraded: completed.length - scored.length,
    errors: results.length - completed.length,
    judgeErrors: results.reduce(
      (sum, result) => sum + (result.judgeErrors ?? 0),
      0,
    ),
    gradedCriteria,
    totalCriteria,
    coverage,
    scoreValid: coverage >= COVERAGE_FLOOR,
    normalizedScore: mean(scored.map((result) => result.score.normalizedScore)),
    passRate: mean(scored.map((result) => result.score.passRate)),
    capBoundRate: completed.length === 0 ? 0 : capBound / completed.length,
    domains,
    sections,
    medianLatencyMs: median(completed.map((result) => result.latencyMs)),
    totalCostUSD,
    averageCostUSD:
      completed.length === 0 ? 0 : totalCostUSD / completed.length,
    averageAgentsSpawned:
      completed.length === 0 ? 0 : totalAgentsSpawned / completed.length,
    averageLatencyMs:
      completed.length === 0 ? 0 : totalLatencyMs / completed.length,
    averageInputTokens:
      completed.length === 0 ? 0 : totalInputTokens / completed.length,
    averageOutputTokens:
      completed.length === 0 ? 0 : totalOutputTokens / completed.length,
    totalInputTokens,
    totalOutputTokens,
    totalCitationsBound: completed.reduce(
      (sum, result) => sum + (result.metrics?.citationsBound ?? 0),
      0,
    ),
    totalCitationsUnsupported: completed.reduce(
      (sum, result) => sum + (result.metrics?.citationsUnsupported ?? 0),
      0,
    ),
    fetchHealth: summarizeFetchHealth(results),
    claimHealth: summarizeClaimHealth(results),
  };
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `eval-runs/draco-${stamp}.jsonl`;
}

function printDryRun(selected: DracoCase[], opts: EvalOptions): void {
  const byDomain: Record<string, number> = {};
  for (const entry of selected) increment(byDomain, entry.domain);
  const lines = [
    `cases: ${selected.length}`,
    `seed: ${opts.seed}`,
    `stratify: ${opts.stratify}`,
    `domains: ${formatCountMap(byDomain)}`,
    "",
    ...selected.map((entry) => {
      const bySection = entry.sections
        .map((section) => {
          const count = entry.criteria.filter(
            (c) => c.sectionId === section.id,
          ).length;
          return `${section.id}:${count}`;
        })
        .join(",");
      return `${entry.id} [${entry.domain}] ${entry.criteria.length} criteria (${bySection})`;
    }),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printSummary(
  summary: ReturnType<typeof summarize>,
  judge: JudgeSpec,
  grader: GraderStrategy,
  outPath: string,
): void {
  process.stdout.write(
    `${[
      `cases: ${summary.total} (scored ${summary.scored}, errors ${summary.errors})`,
      `normalized score: ${(summary.normalizedScore * 100).toFixed(1)}%`,
      `pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
      `budget-exhausted rate: ${(summary.capBoundRate * 100).toFixed(1)}%`,
      `judge: ${judge.provider}/${judge.modelId} (${grader})`,
      ...(summary.judgeErrors ? [`judge errors: ${summary.judgeErrors}`] : []),
      `grading coverage: ${(summary.coverage * 100).toFixed(1)}% (${summary.gradedCriteria}/${summary.totalCriteria} criteria graded${
        summary.ungraded ? `, ${summary.ungraded} task(s) ungraded` : ""
      })`,
      ...(summary.scoreValid
        ? []
        : [
            `WARNING: grading coverage ${(summary.coverage * 100).toFixed(1)}% < ${(COVERAGE_FLOOR * 100).toFixed(0)}% — scores are NOT comparable; treat normalized score as invalid for this run.`,
          ]),
      "by domain:",
      ...summary.domains.map(
        (d) =>
          `  ${d.domain}: ${(d.normalizedScore * 100).toFixed(1)}% (pass ${(d.passRate * 100).toFixed(1)}%, n=${d.tasks})`,
      ),
      "by section:",
      ...summary.sections.map(
        (s) =>
          `  ${s.title}: ${(s.normalizedScore * 100).toFixed(1)}% (pass ${(s.passRate * 100).toFixed(1)}%)`,
      ),
      `avg latency: ${(summary.averageLatencyMs / 1000).toFixed(1)}s, avg input tokens: ${Math.round(summary.averageInputTokens).toLocaleString("en-US")}, avg output tokens: ${Math.round(summary.averageOutputTokens).toLocaleString("en-US")}`,
      `median latency: ${(summary.medianLatencyMs / 1000).toFixed(1)}s`,
      `avg cost: $${summary.averageCostUSD.toFixed(2)} (total $${summary.totalCostUSD.toFixed(2)}, agents spawned ${summary.averageAgentsSpawned.toFixed(1)}/task)`,
      `citations: bound=${summary.totalCitationsBound}, unsupported=${summary.totalCitationsUnsupported}`,
      `claims: extracted=${summary.claimHealth.extracted}, unsupported=${summary.claimHealth.unsupported}, verified=${summary.claimHealth.verified}, confirmed=${summary.claimHealth.confirmed}, contested=${summary.claimHealth.contested}, refuted=${summary.claimHealth.refuted}, unverified=${summary.claimHealth.unverified}`,
      `fetch health: fetched=${summary.fetchHealth.fetched}, rejected=${summary.fetchHealth.rejected}, blocked_or_thin=${summary.fetchHealth.blockedOrThin}, methods=${formatCountMap(summary.fetchHealth.fetchedByMethod)}`,
      `results: ${outPath}`,
    ].join("\n")}\n`,
  );
}

async function regradeCase(
  prior: EvalResult,
  opts: EvalOptions,
  judge: JudgeSpec,
): Promise<EvalResult> {
  if (
    !prior.markdown ||
    !Array.isArray(prior.report) ||
    prior.report.length === 0
  ) {
    return prior;
  }
  const criteria: DracoCriterion[] = prior.report.map((c) => ({
    sectionId: c.sectionId,
    sectionTitle: titleFromId(c.sectionId),
    id: c.id,
    weight: c.weight,
    requirement: c.requirement,
  }));
  const sectionIds = [...new Set(criteria.map((c) => c.sectionId))];
  const entry: DracoCase = {
    id: prior.id,
    domain: prior.domain,
    problem: prior.problem,
    rubricId: prior.id,
    sections: sectionIds.map((id) => ({ id, title: titleFromId(id) })),
    criteria,
    raw: {},
  };
  process.stderr.write(
    `eval:draco: ${prior.id} [${prior.domain}]: regrading ${criteria.length} criteria (${opts.grader}, ${judge.provider}/${judge.modelId})\n`,
  );
  const report = await gradeRubric({
    judge,
    grader: opts.grader,
    criteria,
    response: prior.markdown,
    query: prior.problem,
    concurrency: opts.judgeConcurrency,
    timeoutMs: opts.judgeTimeoutMs,
  });
  const judgeErrors = report.filter((r) => r.judgeError).length;
  const score =
    judgeErrors < report.length ? buildScore(report, entry) : undefined;
  if (score) {
    process.stderr.write(
      `eval:draco: ${prior.id} [${prior.domain}]: score ${(score.normalizedScore * 100).toFixed(1)}% pass ${(score.passRate * 100).toFixed(1)}% (${score.gradedCriteria}/${score.criteria} criteria graded)\n`,
    );
  }
  return {
    type: "result",
    id: prior.id,
    domain: prior.domain,
    problem: prior.problem,
    ...(score ? { score } : {}),
    report,
    ...(judgeErrors ? { judgeErrors } : {}),
    ...(prior.capBound !== undefined ? { capBound: prior.capBound } : {}),
    ...(prior.markdown ? { markdown: prior.markdown } : {}),
    latencyMs: prior.latencyMs ?? 0,
    trace: prior.trace ?? [],
    ...(prior.diagnostics ? { diagnostics: prior.diagnostics } : {}),
    ...(prior.metrics ? { metrics: prior.metrics } : {}),
  };
}

async function runRegrade(opts: EvalOptions): Promise<void> {
  const text = await readText(opts.regrade as string);
  const rows = text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const priorResults = rows.filter(
    (row) => row.type === "result",
  ) as unknown as EvalResult[];
  if (priorResults.length === 0) {
    fail(`no result rows found in ${opts.regrade}`);
  }
  const priorManifest = rows.find((row) => row.type === "manifest");
  const judge = buildJudgeSpec(opts);
  const manifest = {
    type: "manifest" as const,
    suite: "draco",
    mode: "regrade" as const,
    regradedFrom: opts.regrade,
    grader: opts.grader,
    judge: { provider: judge.provider, model: judge.modelId },
    research: priorManifest?.research ?? null,
    casesRevision: priorManifest?.casesRevision ?? null,
    seed: priorManifest?.seed ?? null,
    cases: priorResults.map((r) => ({
      id: r.id,
      domain: r.domain,
      criteria: r.report?.length ?? 0,
    })),
  };
  const results = await mapWithConcurrency(
    priorResults,
    opts.concurrency,
    (prior) => regradeCase(prior, opts, judge),
  );
  const summary = summarize(results);
  const outPath =
    opts.outPath ?? defaultOutPath().replace("draco-", "draco-regrade-");
  await writeJsonl(outPath, [manifest, ...results, summary]);
  printSummary(summary, judge, opts.grader, outPath);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.regrade) {
    await runRegrade(opts);
    return;
  }
  const cases = await readCases(opts.casesPath);
  const selected = selectCases(cases, opts);
  if (selected.length === 0) fail("no cases selected");

  if (opts.dryRun) {
    printDryRun(selected, opts);
    return;
  }

  const judge = buildJudgeSpec(opts);
  const researchProvider = resolveResearchProvider(opts.provider);
  const researchModel = resolveResearchModel(researchProvider, opts.model);
  const manifest = {
    type: "manifest" as const,
    suite: "draco",
    seed: opts.seed,
    sample: opts.sample ?? null,
    stratify: opts.stratify,
    grader: opts.grader,
    casesPath: opts.casesPath,
    casesRevision: huggingfaceRevision(opts.casesPath),
    research: {
      provider: researchProvider,
      model: researchModel,
      leafModel: effectiveLeafModel(opts) ?? researchModel,
    },
    judge: { provider: judge.provider, model: judge.modelId },
    effort: opts.effort,
    timeoutMs: opts.timeoutMs ?? null,
    budgetUSD: opts.budgetUSD ?? null,
    cases: selected.map((entry) => ({
      id: entry.id,
      domain: entry.domain,
      criteria: entry.criteria.length,
    })),
  };

  const results = await mapWithConcurrency(
    selected,
    opts.concurrency,
    (entry) => runCase(entry, opts, judge),
  );
  const summary = summarize(results);
  const outPath = opts.outPath ?? defaultOutPath();
  await writeJsonl(outPath, [manifest, ...results, summary]);

  printSummary(summary, judge, opts.grader, outPath);
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
