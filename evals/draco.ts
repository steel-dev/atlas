import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateObject, jsonSchema } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../src/defaults.js";
import {
  streamResearch,
  type LanguageModel,
  type ModelProvider,
  type ResearchEvent,
  type ResearchResult,
} from "../src/research.js";
import { steel } from "../src/steel.js";
import { resolveModelSpec } from "../src/config-resolution.js";

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
  tokenLimit?: number;
  teamSize?: number;
  provider?: ModelProvider;
  model?: string;
  openaiBaseUrl?: string;
  grader: GraderStrategy;
  judgeProvider?: JudgeProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeTimeoutMs: number;
  judgeConcurrency: number;
  concurrency: number;
  retries: number;
  regrade?: string;
  useProxy: boolean;
  dryRun: boolean;
}

interface JudgeSpec {
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
}

interface SectionScore {
  id: string;
  title: string;
  criteria: number;
  rawScore: number;
  normalizedScore: number;
  passRate: number;
}

interface RubricScore {
  criteria: number;
  gradedCriteria: number;
  rawScore: number;
  positiveWeight: number;
  negativeWeight: number;
  normalizedScore: number;
  passRate: number;
  sections: SectionScore[];
}

interface SubagentMetrics {
  task: string;
  startedAtMs?: number;
  finishedAtMs: number;
  durationMs?: number;
  sourcesFetched: number;
  toolCalls: number;
  finishReason: string;
}

interface DepthDiagnostics {
  searches: number;
  fetches: number;
  sourcesFetched: number;
  sourceErrors: number;
  qualityWarnings: number;
}

interface ChokeDiagnostics {
  budgetExhaustedSubagents: number;
  timeoutSubagents: number;
  sourceErrors: number;
  blockedOrThinSources: number;
  blockedOrThinByHost: Record<string, number>;
  subagentFinishReasons: Record<string, number>;
}

interface EvalDiagnostics {
  search: {
    events: number;
    possibleBatchedGroups: number;
    maxQueriesPerGroup: number;
    stringifiedArrayLikeQueries: number;
  };
  fetch: {
    fetched: number;
    rejected: number;
    fetchedByMethod: Record<string, number>;
    fetchedByDepthAndMethod: Record<string, Record<string, number>>;
    failedAttemptsByMethod: Record<string, number>;
    qualityWarningsByCode: Record<string, number>;
    sourceErrorsByCode: Record<string, number>;
    fetchedHosts: Record<string, number>;
    rejectedHosts: Record<string, number>;
    totalFetchedMarkdownChars: number;
  };
  cost: {
    latencyMs: number;
    toolCalls?: number;
    leadToolCalls?: number;
    subagentToolCalls?: number;
    totalToolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  depth: Record<string, DepthDiagnostics>;
  choke: ChokeDiagnostics;
}

interface EvalResult {
  type: "result";
  id: string;
  domain: string;
  problem: string;
  score?: RubricScore;
  report?: CriterionReport[];
  judgeErrors?: number;
  error?: string;
  finishReason?: string;
  markdown?: string;
  latencyMs: number;
  trace: EvalTraceEvent[];
  diagnostics?: EvalDiagnostics;
  metrics?: {
    provider: ModelProvider;
    model: string;
    toolCalls: number;
    leadToolCalls: number;
    subagentToolCalls: number;
    totalToolCalls: number;
    subagents: SubagentMetrics[];
    fetchedUrls: string[];
    citedSources: number;
    citationsNotFetched: number;
    inputTokens: number;
    outputTokens: number;
  };
}

type EvalTraceEvent = {
  atMs: number;
  event: ResearchEvent["type"];
  depth?: number;
  index?: number;
  query?: string;
  count?: number;
  results?: Array<{
    url: string;
    domain: string;
    title?: string;
    snippet?: string;
  }>;
  tasks?: string[];
  task?: string;
  url?: string;
  title?: string;
  method?: string;
  error?: string;
  retryAfterSeconds?: number;
  attempt?: number;
  maxAttempts?: number;
  attempts?: Array<{ method: string; ok: boolean; note: string }>;
  qualityWarnings?: string[];
  sourcesFetched?: number;
  toolCalls?: number;
  finishReason?: string;
  markdownChars?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  foldedMessages?: number;
  from?: string;
  to?: string;
  chars?: number;
  result?: {
    citedSources: number;
    citationsNotFetched: number;
    markdownChars: number;
  };
};

const DRACO_DATASET_REVISION = "ce076749809027649ebd331bcb70f42bf720d387";
const DEFAULT_CASES_URL = `https://huggingface.co/datasets/perplexity-ai/draco/resolve/${DRACO_DATASET_REVISION}/test.jsonl`;
const DEFAULT_SEED = "atlas-draco-v1";
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;
const DEFAULT_JUDGE_CONCURRENCY = 8;
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
      --token-limit N         Total token budget per task (0 = unlimited)
      --team N                Suggest up to N parallel sub-agents per task (default: 1)
      --provider NAME         Research model provider: anthropic, openai
      --model NAME            Research model name
      --base-url URL          OpenAI-compatible base URL for the research model
      --grader MODE           per-criterion | one-shot (default: per-criterion)
      --judge-provider P      Judge provider: google, anthropic, openai (default: google)
      --judge-model MODEL     Judge model (default: gemini-3.1-pro-preview / claude-sonnet-4-5 / gpt-5.2)
      --judge-base-url URL    OpenAI-compatible base URL for the judge
      --judge-timeout N       Per-criterion judge timeout in seconds (default: ${DEFAULT_JUDGE_TIMEOUT_MS / 1000})
      --judge-concurrency N   Parallel judge calls per task (default: ${DEFAULT_JUDGE_CONCURRENCY})
      --concurrency N         Parallel tasks (default: 1)
      --retries N             Retry a task's research run on transient errors (default: 1)
      --regrade <file>        Re-judge a prior results JSONL (no research); reuses saved reports
      --proxy                 Route Steel calls through proxy
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

function parseArgs(argv: string[]): EvalOptions {
  const caseIds = new Set<string>();
  const domains = new Set<string>();
  const opts: EvalOptions = {
    casesPath: DEFAULT_CASES_URL,
    seed: DEFAULT_SEED,
    caseIds,
    domains,
    stratify: "domain",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    grader: "per-criterion",
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    judgeConcurrency: DEFAULT_JUDGE_CONCURRENCY,
    concurrency: 1,
    retries: 1,
    useProxy: false,
    dryRun: false,
  };

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
    if (arg === "--token-limit") {
      opts.tokenLimit = readNonNegativeInt(readValue(argv, i, arg), arg);
      i++;
      continue;
    }
    if (arg === "--team") {
      opts.teamSize = readPositiveInt(readValue(argv, i, arg), arg);
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
    if (arg === "--base-url") {
      opts.openaiBaseUrl = readValue(argv, i, arg);
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
    if (arg === "--judge-base-url") {
      opts.judgeBaseUrl = readValue(argv, i, arg);
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
    if (arg === "--proxy") {
      opts.useProxy = true;
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

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function huggingfaceRevision(pathOrUrl: string): string | null {
  const match = pathOrUrl.match(/huggingface\.co\/.+\/resolve\/([^/?#]+)\//);
  return match ? match[1] : null;
}

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function resolveResearchProvider(
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

function resolveResearchModel(
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

function defaultJudgeModel(provider: JudgeProvider): string {
  if (provider === "google") return "gemini-3.1-pro-preview";
  if (provider === "anthropic") return "claude-sonnet-4-5";
  return "gpt-5.2";
}

export function buildJudgeSpec(opts: EvalOptions): JudgeSpec {
  const provider = opts.judgeProvider ?? "google";
  const modelId = opts.judgeModel ?? defaultJudgeModel(provider);
  if (provider === "google") {
    const apiKey = readEnv(
      "ATLAS_GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    );
    if (!apiKey) {
      fail(
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
      fail(
        "judge: ANTHROPIC_API_KEY is required for --judge-provider anthropic",
      );
    return { provider, modelId, model: createAnthropic({ apiKey })(modelId) };
  }
  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey)
    fail("judge: OPENAI_API_KEY is required for --judge-provider openai");
  const baseURL =
    opts.judgeBaseUrl ?? readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
  return {
    provider,
    modelId,
    model: createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })(modelId),
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

async function readCases(path: string): Promise<DracoCase[]> {
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

async function gradePerCriterion(
  judge: JudgeSpec,
  criterion: DracoCriterion,
  response: string,
  query: string,
  timeoutMs: number,
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
    const { object } = await generateObject({
      model: judge.model,
      system: PER_CRITERION_SYSTEM_PROMPT,
      prompt,
      schema: jsonSchema(PER_CRITERION_JSON_SCHEMA),
      temperature: JUDGE_TEMPERATURE,
      maxOutputTokens: PER_CRITERION_JUDGE_MAX_TOKENS,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
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
    const { object } = await generateObject({
      model: judge.model,
      system: ONE_SHOT_SYSTEM_PROMPT,
      prompt,
      schema: jsonSchema(ONE_SHOT_JSON_SCHEMA),
      temperature: JUDGE_TEMPERATURE,
      maxOutputTokens: ONE_SHOT_JUDGE_MAX_TOKENS,
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
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
}): Promise<CriterionReport[]> {
  if (opts.grader === "one-shot") {
    return gradeOneShot(
      opts.judge,
      opts.criteria,
      opts.response,
      opts.query,
      opts.timeoutMs,
    );
  }
  return mapWithConcurrency(opts.criteria, opts.concurrency, (criterion) =>
    gradePerCriterion(
      opts.judge,
      criterion,
      opts.response,
      opts.query,
      opts.timeoutMs,
    ),
  );
}

function summarizeSubagents(trace: EvalTraceEvent[]): SubagentMetrics[] {
  const startsByTask = new Map<string, number[]>();
  const subagents: SubagentMetrics[] = [];
  for (const event of trace) {
    if (event.event === "subagent_started" && event.task) {
      const starts = startsByTask.get(event.task) ?? [];
      starts.push(event.atMs);
      startsByTask.set(event.task, starts);
      continue;
    }
    if (event.event !== "subagent_finished" || !event.task) continue;
    const starts = startsByTask.get(event.task) ?? [];
    const startedAtMs = starts.shift();
    if (starts.length === 0) startsByTask.delete(event.task);
    const finishedAtMs = event.atMs;
    subagents.push({
      task: event.task,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      finishedAtMs,
      ...(startedAtMs !== undefined
        ? { durationMs: Math.max(0, finishedAtMs - startedAtMs) }
        : {}),
      sourcesFetched: event.sourcesFetched ?? 0,
      toolCalls: event.toolCalls ?? 0,
      finishReason: event.finishReason ?? "unknown",
    });
  }
  return subagents;
}

function summarizeRun(
  result: ResearchResult,
  trace: EvalTraceEvent[],
): EvalResult["metrics"] {
  const leadToolCalls = result.runs.reduce(
    (sum, run) => sum + run.toolCalls,
    0,
  );
  const subagents = summarizeSubagents(trace);
  const subagentToolCalls = subagents.reduce(
    (sum, subagent) => sum + subagent.toolCalls,
    0,
  );
  const totalToolCalls = leadToolCalls + subagentToolCalls;
  return {
    provider: result.provider,
    model: result.model,
    toolCalls: totalToolCalls,
    leadToolCalls,
    subagentToolCalls,
    totalToolCalls,
    subagents,
    fetchedUrls: result.runs.flatMap((run) => run.fetchedUrls),
    citedSources: result.citedSources.length,
    citationsNotFetched: result.citationsNotFetched.length,
    inputTokens:
      result.usage.input_tokens +
      result.usage.cache_creation_input_tokens +
      result.usage.cache_read_input_tokens,
    outputTokens: result.usage.output_tokens,
  };
}

function progressLine(caseId: string, event: ResearchEvent): string | null {
  switch (event.type) {
    case "searching":
      return `${caseId}: search[${event.index}] ${event.query}`;
    case "search_results":
      return `${caseId}: search[${event.index}] ${event.count} result(s)`;
    case "search_failed":
      return `${caseId}: search[${event.index}] failed: ${event.error}`;
    case "fetching":
      return `${caseId}: fetch ${event.url}`;
    case "source_fetched":
      return `${caseId}: fetched ${event.url}${event.method ? ` (${event.method})` : ""}`;
    case "source_error":
      return `${caseId}: source error ${event.url}: ${event.error}`;
    case "rate_limited":
      return `${caseId}: rate limited, waiting ${event.retryAfterSeconds}s`;
    case "research_finished":
      return `${caseId}: research finished with ${event.sourcesFetched} source(s)`;
    case "context_compacted":
      return `${caseId}: context compacted ${event.tokensBefore} -> ${event.tokensAfter} tok (${event.foldedMessages} message(s) folded)`;
    case "delegation_started":
      return `${caseId}: delegating ${event.tasks.length} sub-agent(s)`;
    case "subagent_started":
      return `${caseId}: sub-agent started: ${event.task.slice(0, 80)}`;
    case "subagent_finished":
      return `${caseId}: sub-agent finished: ${event.sourcesFetched} source(s), ${event.toolCalls} tool call(s), ${event.finishReason}`;
    case "citations_not_fetched":
      return `${caseId}: ${event.count} citation(s) not fetched`;
    case "written":
      return `${caseId}: wrote ${event.markdownChars} markdown chars`;
    case "message_sent":
      return `${caseId}: message ${event.from} -> ${event.to} (${event.chars} chars)`;
    case "completed":
    case "research_started":
    case "report-boundary":
    case "report-delta":
    case "tool_event":
      return null;
  }
}

function traceEvent(event: ResearchEvent, started: number): EvalTraceEvent {
  const base = {
    atMs: Date.now() - started,
    event: event.type,
    ...(event.depth !== undefined ? { depth: event.depth } : {}),
  };
  switch (event.type) {
    case "searching":
      return { ...base, index: event.index, query: event.query };
    case "search_results":
      return {
        ...base,
        index: event.index,
        count: event.count,
        ...(event.results ? { results: event.results } : {}),
      };
    case "search_failed":
      return { ...base, index: event.index, error: event.error };
    case "fetching":
      return { ...base, url: event.url };
    case "rate_limited":
      return {
        ...base,
        retryAfterSeconds: event.retryAfterSeconds,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      };
    case "source_fetched":
      return {
        ...base,
        url: event.url,
        title: event.title,
        ...(event.method ? { method: event.method } : {}),
        ...(event.markdownChars !== undefined
          ? { markdownChars: event.markdownChars }
          : {}),
        ...(event.attempts ? { attempts: event.attempts } : {}),
        ...(event.qualityWarnings
          ? { qualityWarnings: event.qualityWarnings }
          : {}),
      };
    case "source_error":
      return { ...base, url: event.url, error: event.error };
    case "research_finished":
      return { ...base, sourcesFetched: event.sourcesFetched };
    case "context_compacted":
      return {
        ...base,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        foldedMessages: event.foldedMessages,
      };
    case "delegation_started":
      return { ...base, tasks: event.tasks };
    case "subagent_started":
      return { ...base, task: event.task };
    case "subagent_finished":
      return {
        ...base,
        task: event.task,
        sourcesFetched: event.sourcesFetched,
        toolCalls: event.toolCalls,
        finishReason: event.finishReason,
      };
    case "citations_not_fetched":
      return { ...base, count: event.count };
    case "written":
      return { ...base, markdownChars: event.markdownChars };
    case "completed":
      return {
        ...base,
        result: {
          citedSources: event.result.citedSources.length,
          citationsNotFetched: event.result.citationsNotFetched.length,
          markdownChars: event.result.markdown.length,
        },
      };
    case "message_sent":
      return { ...base, from: event.from, to: event.to, chars: event.chars };
    case "research_started":
    case "report-boundary":
    case "report-delta":
    case "tool_event":
      return base;
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function incrementNested(
  counts: Record<string, Record<string, number>>,
  outer: string,
  inner: string,
): void {
  counts[outer] ??= {};
  counts[outer][inner] = (counts[outer][inner] ?? 0) + 1;
}

function hostFromUrl(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "invalid";
  }
}

function codeFromMessage(message: string | undefined): string {
  if (!message) return "unknown";
  const match = message.match(/^([a-z_]+):/i);
  return match?.[1] ?? "unknown";
}

function looksLikeStringifiedArrayQuery(query: string): boolean {
  const trimmed = query.trim();
  return (
    /^\[[\s\S]*\]$/.test(trimmed) ||
    (trimmed.includes('",') && trimmed.includes("[") && trimmed.includes("]"))
  );
}

function searchGroups(searchEvents: EvalTraceEvent[]): EvalTraceEvent[][] {
  const groups: EvalTraceEvent[][] = [];
  let current: EvalTraceEvent[] = [];
  for (const event of searchEvents) {
    const previous = current[current.length - 1];
    if (!previous || event.atMs - previous.atMs <= 50) {
      current.push(event);
      continue;
    }
    groups.push(current);
    current = [event];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function depthKey(event: EvalTraceEvent): string {
  return String(event.depth ?? 0);
}

function ensureDepthDiagnostics(
  depths: Record<string, DepthDiagnostics>,
  key: string,
): DepthDiagnostics {
  const existing = depths[key];
  if (existing) return existing;
  const created = {
    searches: 0,
    fetches: 0,
    sourcesFetched: 0,
    sourceErrors: 0,
    qualityWarnings: 0,
  };
  depths[key] = created;
  return created;
}

function isBudgetExhausted(reason: string | undefined): boolean {
  return /\btool call budget exhausted\b|\btool execution safety budget exhausted\b/i.test(
    reason ?? "",
  );
}

function isTimeoutFinish(reason: string | undefined): boolean {
  return /\btimeout approaching\b/i.test(reason ?? "");
}

function isBlockedOrThin(warnings: string[] | undefined): boolean {
  return (warnings ?? []).some((warning) =>
    /\b(?:blocked_or_challenge|thin_content|error_page)\b/i.test(warning),
  );
}

function buildDiagnostics(opts: {
  trace: EvalTraceEvent[];
  latencyMs: number;
  metrics?: EvalResult["metrics"];
}): EvalDiagnostics {
  const searchEvents = opts.trace.filter(
    (event) => event.event === "searching",
  );
  const groups = searchGroups(searchEvents);
  const fetchedByMethod: Record<string, number> = {};
  const fetchedByDepthAndMethod: Record<string, Record<string, number>> = {};
  const failedAttemptsByMethod: Record<string, number> = {};
  const qualityWarningsByCode: Record<string, number> = {};
  const sourceErrorsByCode: Record<string, number> = {};
  const fetchedHosts: Record<string, number> = {};
  const rejectedHosts: Record<string, number> = {};
  const depth: Record<string, DepthDiagnostics> = {};
  const blockedOrThinByHost: Record<string, number> = {};
  const subagentFinishReasons: Record<string, number> = {};
  let blockedOrThinSources = 0;
  let fetched = 0;
  let rejected = 0;
  let totalFetchedMarkdownChars = 0;

  for (const event of opts.trace) {
    const depthStats = ensureDepthDiagnostics(depth, depthKey(event));
    if (event.event === "searching") {
      depthStats.searches++;
      continue;
    }
    if (event.event === "fetching") {
      depthStats.fetches++;
      continue;
    }
    if (event.event === "source_fetched") {
      fetched++;
      depthStats.sourcesFetched++;
      increment(fetchedByMethod, event.method ?? "unknown");
      incrementNested(
        fetchedByDepthAndMethod,
        depthKey(event),
        event.method ?? "unknown",
      );
      increment(fetchedHosts, hostFromUrl(event.url));
      totalFetchedMarkdownChars += event.markdownChars ?? 0;
      if (isBlockedOrThin(event.qualityWarnings)) {
        blockedOrThinSources++;
        increment(blockedOrThinByHost, hostFromUrl(event.url));
      }
      for (const warning of event.qualityWarnings ?? []) {
        depthStats.qualityWarnings++;
        increment(qualityWarningsByCode, codeFromMessage(warning));
      }
      for (const attempt of event.attempts ?? []) {
        if (!attempt.ok) increment(failedAttemptsByMethod, attempt.method);
      }
      continue;
    }
    if (event.event === "source_error") {
      rejected++;
      depthStats.sourceErrors++;
      increment(rejectedHosts, hostFromUrl(event.url));
      increment(sourceErrorsByCode, codeFromMessage(event.error));
      continue;
    }
    if (event.event === "subagent_finished") {
      increment(subagentFinishReasons, event.finishReason ?? "unknown");
    }
  }
  const subagents = opts.metrics?.subagents ?? summarizeSubagents(opts.trace);

  return {
    search: {
      events: searchEvents.length,
      possibleBatchedGroups: groups.filter((group) => group.length > 1).length,
      maxQueriesPerGroup: Math.max(0, ...groups.map((group) => group.length)),
      stringifiedArrayLikeQueries: searchEvents.filter(
        (event) => event.query && looksLikeStringifiedArrayQuery(event.query),
      ).length,
    },
    fetch: {
      fetched,
      rejected,
      fetchedByMethod,
      fetchedByDepthAndMethod,
      failedAttemptsByMethod,
      qualityWarningsByCode,
      sourceErrorsByCode,
      fetchedHosts,
      rejectedHosts,
      totalFetchedMarkdownChars,
    },
    cost: {
      latencyMs: opts.latencyMs,
      ...(opts.metrics
        ? {
            toolCalls: opts.metrics.toolCalls,
            leadToolCalls: opts.metrics.leadToolCalls,
            subagentToolCalls: opts.metrics.subagentToolCalls,
            totalToolCalls: opts.metrics.totalToolCalls,
            inputTokens: opts.metrics.inputTokens,
            outputTokens: opts.metrics.outputTokens,
          }
        : {}),
    },
    depth,
    choke: {
      budgetExhaustedSubagents: subagents.filter((subagent) =>
        isBudgetExhausted(subagent.finishReason),
      ).length,
      timeoutSubagents: subagents.filter((subagent) =>
        isTimeoutFinish(subagent.finishReason),
      ).length,
      sourceErrors: rejected,
      blockedOrThinSources,
      blockedOrThinByHost,
      subagentFinishReasons,
    },
  };
}

function isTransientResearchError(message: string): boolean {
  return /rate limit|concurrent connections|overloaded|temporarily|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b(408|429|500|502|503|504)\b/i.test(
    message,
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
      const run = streamResearch({
        query: entry.problem,
        ...resolveModelSpec({
          provider: opts.provider,
          model: opts.model,
          baseUrl: opts.openaiBaseUrl,
        }),
        timeoutMs: opts.timeoutMs,
        tokenLimit: opts.tokenLimit,
        suggestedTeamSize: opts.teamSize,
        includeSourceDocuments: true,
        browser: steel({ proxy: opts.useProxy }),
      });
      for await (const event of run.events) {
        trace.push(traceEvent(event, started));
        const line = progressLine(entry.id, event);
        if (line) process.stderr.write(`eval:draco: ${line}\n`);
      }
      return await run.result;
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
    const report = await gradeRubric({
      judge,
      grader: opts.grader,
      criteria: entry.criteria,
      response: result.markdown,
      query: entry.problem,
      concurrency: opts.judgeConcurrency,
      timeoutMs: opts.judgeTimeoutMs,
    });
    const judgeErrors = report.filter((r) => r.judgeError).length;
    const score =
      judgeErrors < report.length ? buildScore(report, entry) : undefined;
    const latencyMs = Date.now() - started;
    const metrics = summarizeRun(result, trace);
    if (score) {
      process.stderr.write(
        `eval:draco: ${entry.id} [${entry.domain}]: score ${(score.normalizedScore * 100).toFixed(1)}% ` +
          `pass ${(score.passRate * 100).toFixed(1)}% (${score.gradedCriteria}/${score.criteria} criteria graded${
            judgeErrors ? `, ${judgeErrors} judge error(s)` : ""
          })\n`,
      );
    } else {
      process.stderr.write(
        `eval:draco: ${entry.id} [${entry.domain}]: UNGRADED — all ${report.length} criteria errored on the judge\n`,
      );
    }
    return {
      type: "result",
      id: entry.id,
      domain: entry.domain,
      problem: entry.problem,
      ...(score ? { score } : {}),
      report,
      ...(judgeErrors ? { judgeErrors } : {}),
      finishReason: result.runs.map((run) => run.finishReason).join("; "),
      markdown: result.markdown,
      latencyMs,
      trace,
      diagnostics: buildDiagnostics({ trace, latencyMs, metrics }),
      metrics,
    };
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key}:${value}`).join(",");
}

function summarizeFetchHealth(results: EvalResult[]) {
  const fetchedByMethod: Record<string, number> = {};
  const failedAttemptsByMethod: Record<string, number> = {};
  let fetched = 0;
  let rejected = 0;
  let totalFetchedMarkdownChars = 0;
  let qualityWarnings = 0;
  for (const result of results) {
    for (const event of result.trace) {
      if (event.event === "source_fetched") {
        fetched++;
        increment(fetchedByMethod, event.method ?? "unknown");
        totalFetchedMarkdownChars += event.markdownChars ?? 0;
        qualityWarnings += event.qualityWarnings?.length ?? 0;
        for (const attempt of event.attempts ?? []) {
          if (!attempt.ok) increment(failedAttemptsByMethod, attempt.method);
        }
        continue;
      }
      if (event.event === "source_error") {
        rejected++;
        continue;
      }
    }
  }
  return {
    fetched,
    rejected,
    fetchedByMethod,
    failedAttemptsByMethod,
    totalFetchedMarkdownChars,
    qualityWarnings,
  };
}

function summarizeChokeDiagnostics(results: EvalResult[]) {
  return results.reduce(
    (summary, result) => {
      const choke = result.diagnostics?.choke;
      if (!choke) return summary;
      summary.budgetExhaustedSubagents += choke.budgetExhaustedSubagents;
      summary.timeoutSubagents += choke.timeoutSubagents;
      summary.sourceErrors += choke.sourceErrors;
      summary.blockedOrThinSources += choke.blockedOrThinSources;
      for (const [host, count] of Object.entries(choke.blockedOrThinByHost)) {
        summary.blockedOrThinByHost[host] =
          (summary.blockedOrThinByHost[host] ?? 0) + count;
      }
      for (const [reason, count] of Object.entries(
        choke.subagentFinishReasons,
      )) {
        summary.subagentFinishReasons[reason] =
          (summary.subagentFinishReasons[reason] ?? 0) + count;
      }
      return summary;
    },
    {
      budgetExhaustedSubagents: 0,
      timeoutSubagents: 0,
      sourceErrors: 0,
      blockedOrThinSources: 0,
      blockedOrThinByHost: {} as Record<string, number>,
      subagentFinishReasons: {} as Record<string, number>,
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
  const totalToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.totalToolCalls ?? 0),
    0,
  );
  const totalLeadToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.leadToolCalls ?? 0),
    0,
  );
  const totalSubagentToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.subagentToolCalls ?? 0),
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
    domains,
    sections,
    medianLatencyMs: median(completed.map((result) => result.latencyMs)),
    averageToolCalls:
      completed.length === 0 ? 0 : totalToolCalls / completed.length,
    averageLeadToolCalls:
      completed.length === 0 ? 0 : totalLeadToolCalls / completed.length,
    averageSubagentToolCalls:
      completed.length === 0 ? 0 : totalSubagentToolCalls / completed.length,
    averageLatencyMs:
      completed.length === 0 ? 0 : totalLatencyMs / completed.length,
    averageInputTokens:
      completed.length === 0 ? 0 : totalInputTokens / completed.length,
    averageOutputTokens:
      completed.length === 0 ? 0 : totalOutputTokens / completed.length,
    totalInputTokens,
    totalOutputTokens,
    totalCitedSources: completed.reduce(
      (sum, result) => sum + (result.metrics?.citedSources ?? 0),
      0,
    ),
    totalCitationsNotFetched: completed.reduce(
      (sum, result) => sum + (result.metrics?.citationsNotFetched ?? 0),
      0,
    ),
    fetchHealth: summarizeFetchHealth(results),
    chokeDiagnostics: summarizeChokeDiagnostics(results),
  };
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `eval-runs/draco-${stamp}.jsonl`;
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(
    resolved,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
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
    [
      `cases: ${summary.total} (scored ${summary.scored}, errors ${summary.errors})`,
      `normalized score: ${(summary.normalizedScore * 100).toFixed(1)}%`,
      `pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
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
      `avg tool calls: ${summary.averageToolCalls.toFixed(1)} (lead ${summary.averageLeadToolCalls.toFixed(1)}, subagent ${summary.averageSubagentToolCalls.toFixed(1)})`,
      `cited sources: ${summary.totalCitedSources}, citations not fetched: ${summary.totalCitationsNotFetched}`,
      `fetch health: fetched=${summary.fetchHealth.fetched}, rejected=${summary.fetchHealth.rejected}, methods=${formatCountMap(summary.fetchHealth.fetchedByMethod)}`,
      `choke: budget_subagents=${summary.chokeDiagnostics.budgetExhaustedSubagents}, timeout_subagents=${summary.chokeDiagnostics.timeoutSubagents}, source_errors=${summary.chokeDiagnostics.sourceErrors}, blocked_or_thin=${summary.chokeDiagnostics.blockedOrThinSources}`,
      `results: ${outPath}`,
    ].join("\n") + "\n",
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
    ...(prior.finishReason ? { finishReason: prior.finishReason } : {}),
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
    research: { provider: researchProvider, model: researchModel },
    judge: { provider: judge.provider, model: judge.modelId },
    timeoutMs: opts.timeoutMs ?? null,
    tokenLimit: opts.tokenLimit ?? null,
    teamSize: opts.teamSize ?? 1,
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
