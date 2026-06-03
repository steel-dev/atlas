import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../src/defaults.js";
import { createAISdkModelAdapter, type ModelAdapter } from "../src/model.js";
import {
  streamResearch,
  type ModelProvider,
  type ResearchEvent,
  type ResearchResult,
} from "../src/research.js";
import { steel } from "../src/steel.js";
import { resolveModelSpec } from "../src/config-resolution.js";
import type { SourceDocument } from "../src/sources.js";
import { normalizeUrlForSource } from "../src/url.js";

interface EvalCase {
  id: string;
  query: string;
  answers: string[];
  raw: Record<string, unknown>;
}

interface EvalOptions {
  casesPath: string;
  sample?: number;
  seed: string;
  caseIds: Set<string>;
  outPath?: string;
  timeoutMs?: number;
  tokenLimit?: number;
  teamSize?: number;
  provider?: ModelProvider;
  model?: string;
  openaiBaseUrl?: string;
  judge: boolean;
  judgeProvider?: ModelProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeTimeoutMs: number;
  concurrency: number;
  useProxy: boolean;
  dryRun: boolean;
}

interface JudgeResult {
  provider: ModelProvider;
  model: string;
  correct: boolean;
  extractedFinalAnswer: string | null;
  reasoning: string;
  confidence: number | null;
  raw: string;
}

interface EvidenceValidation {
  checked: number;
  valid: number;
  invalid: number;
  items: EvidenceValidationItem[];
}

interface EvidenceValidationItem {
  index: number;
  valid: boolean;
  clue?: string;
  source_id?: string;
  source_url?: string;
  source_title?: string;
  start?: number;
  end?: number;
  quote?: string;
  quote_found_elsewhere_at?: number;
  reason?: string;
}

interface EvalResult {
  type: "result";
  id: string;
  query: string;
  expectedAnswers: string[];
  predictedAnswer: string | null;
  exactCorrect: boolean;
  correct: boolean;
  structured?: unknown;
  evidenceValidation?: EvidenceValidation;
  judge?: JudgeResult;
  judgeError?: string;
  error?: string;
  finishReason?: string;
  markdown?: string;
  latencyMs: number;
  trace: EvalTraceEvent[];
  diagnostics?: EvalDiagnostics;
  metrics?: {
    provider: ModelProvider;
    model: string;
    /** Total action tool calls, including lead, sub-agents, and structured follow-ups. */
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
  attempts?: Array<{
    method: string;
    ok: boolean;
    note: string;
  }>;
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

const DEFAULT_CASES_PATH = "evals/cases/browsecomp.jsonl";
const OFFICIAL_BROWSECOMP_CASES_URL =
  "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

function usage(): string {
  return `Usage:
  npm run eval:browsecomp -- --cases <jsonl|csv|url> [options]

Options:
      --cases <file>       JSONL, JSON array, CSV, or URL of cases
      --sample N           Deterministically sample N cases
      --seed TEXT          Sampling seed (default: atlas-browsecomp-v1)
      --case-id ID         Run one case ID; repeat or comma-separate
      --out <file>         Write manifest/results/summary JSONL
      --timeout N          Per-case timeout in seconds (default: 300)
      --token-limit N      Total token budget per case (e.g. 1000000, 3000000, 10000000)
      --team N             Suggest up to N parallel sub-agents per case (default: 1)
      --provider NAME      Model provider: anthropic, openai
      --model NAME         Model name
      --base-url URL       OpenAI-compatible base URL
      --judge              Grade responses with an LLM judge
      --judge-provider P   Judge provider: anthropic, openai (default: run provider/env)
      --judge-model MODEL  Judge model (default: provider-specific/env)
      --judge-base-url URL OpenAI-compatible base URL for judge
      --judge-timeout N    Per-judge timeout in seconds (default: 60)
      --concurrency N      Parallel cases (default: 1)
      --proxy              Route Steel calls through proxy
      --dry-run            Print selected case IDs without calling APIs
      --help               Show this help

Case fields:
  id: string
  question | problem | query | prompt | input: string
  answer | answers | correct_answer | target | ideal | reference_answer: string|string[]
  canary: string (optional; decrypts OpenAI BrowseComp problem/answer CSV rows)
`;
}

function fail(message: string): never {
  process.stderr.write(`eval:browsecomp: ${message}\n`);
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

function readProvider(raw: string): ModelProvider {
  if (raw === "anthropic" || raw === "openai") return raw;
  fail(`--provider must be one of: anthropic, openai (got "${raw}")`);
}

function parseArgs(argv: string[]): EvalOptions {
  const caseIds = new Set<string>();
  const opts: EvalOptions = {
    casesPath: DEFAULT_CASES_PATH,
    seed: "atlas-browsecomp-v1",
    caseIds,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    judge: false,
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    concurrency: 1,
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
    if (arg === "--case-id") {
      for (const id of readValue(argv, i, arg).split(",")) {
        const trimmed = id.trim();
        if (trimmed) caseIds.add(trimmed);
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
      opts.timeoutMs = Math.floor(
        readPositiveNumber(readValue(argv, i, arg), arg) * 1000,
      );
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
    if (arg === "--judge") {
      opts.judge = true;
      continue;
    }
    if (arg === "--judge-provider") {
      opts.judgeProvider = readProvider(readValue(argv, i, arg));
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
    if (arg === "--concurrency") {
      opts.concurrency = readPositiveInt(readValue(argv, i, arg), arg);
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

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function resolveEvalProvider(
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

function resolveEvalModel(
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

function createAnthropicModelAdapter(opts: {
  apiKey: string;
  model: string;
}): ModelAdapter {
  const provider = createAnthropic({ apiKey: opts.apiKey });
  return createAISdkModelAdapter({
    model: provider(opts.model),
    provider: "anthropic",
    modelId: opts.model,
  });
}

function createOpenAIModelAdapter(opts: {
  apiKey: string;
  baseUrl?: string;
  model: string;
}): ModelAdapter {
  const provider = createOpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
  });
  return createAISdkModelAdapter({
    model: provider(opts.model),
    provider: "openai",
    modelId: opts.model,
  });
}

function createJudgeAdapter(opts: EvalOptions): ModelAdapter {
  const provider = resolveEvalProvider(opts.judgeProvider ?? opts.provider);
  const model = resolveEvalModel(provider, opts.judgeModel ?? opts.model);
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) {
      fail(
        "judge: ANTHROPIC_API_KEY or ATLAS_ANTHROPIC_API_KEY is required for provider=anthropic",
      );
    }
    return createAnthropicModelAdapter({ apiKey, model });
  }

  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey) {
    fail(
      "judge: OPENAI_API_KEY or ATLAS_OPENAI_API_KEY is required for provider=openai",
    );
  }
  const baseUrl =
    opts.judgeBaseUrl ??
    opts.openaiBaseUrl ??
    readEnv("ATLAS_OPENAI_BASE_URL", "OPENAI_BASE_URL");
  return createOpenAIModelAdapter({ apiKey, baseUrl, model });
}

function deriveKey(password: string, length: number): Buffer {
  const digest = createHash("sha256").update(password).digest();
  const chunks: Buffer[] = [];
  while (Buffer.concat(chunks).length < length) chunks.push(digest);
  return Buffer.concat(chunks).subarray(0, length);
}

function decryptBrowseCompValue(value: string, canary: string): string {
  const encrypted = Buffer.from(value, "base64");
  const key = deriveKey(canary, encrypted.length);
  return Buffer.from(
    encrypted.map((byte, index) => byte ^ key[index]),
  ).toString("utf8");
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readFirstString(
  raw: Record<string, unknown>,
  fields: string[],
): string | undefined {
  for (const field of fields) {
    const value = optionalString(raw[field]);
    if (value) return value;
  }
  return undefined;
}

function readAnswers(raw: Record<string, unknown>): string[] {
  for (const field of [
    "answers",
    "answer",
    "correct_answer",
    "target",
    "ideal",
    "reference_answer",
  ]) {
    const value = raw[field];
    if (Array.isArray(value)) {
      return value
        .map((entry) => optionalString(entry))
        .filter((entry): entry is string => Boolean(entry));
    }
    const answer = optionalString(value);
    if (answer) return [answer];
  }
  return [];
}

function maybeDecryptBrowseCompRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const canary = optionalString(record.canary);
  if (!canary) return record;
  const decrypted = { ...record };
  for (const field of ["problem", "answer"]) {
    const value = optionalString(record[field]);
    if (!value) continue;
    try {
      decrypted[field] = decryptBrowseCompValue(value, canary);
    } catch {
      decrypted[field] = value;
    }
  }
  return decrypted;
}

function normalizeCase(raw: unknown, index: number): EvalCase {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`case ${index + 1} is not an object`);
  }
  const record = maybeDecryptBrowseCompRecord(raw as Record<string, unknown>);
  const query = readFirstString(record, [
    "question",
    "problem",
    "query",
    "prompt",
    "input",
  ]);
  if (!query) {
    fail(
      `case ${index + 1} is missing a question/problem/query/prompt/input field`,
    );
  }
  const answers = readAnswers(record);
  if (answers.length === 0) {
    fail(
      `case ${index + 1} (${query.slice(0, 60)}) is missing an answer field`,
    );
  }
  const id =
    readFirstString(record, ["id", "question_id", "uid", "name"]) ??
    `case-${stableHash(query).slice(0, 12)}`;
  return { id, query, answers, raw: record };
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

function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field);
  rows.push(row);

  const [headers, ...records] = rows.filter((entry) =>
    entry.some((value) => value.trim()),
  );
  if (!headers) return [];
  return records.map((record) =>
    Object.fromEntries(
      headers.map((header, index) => [header.trim(), record[index] ?? ""]),
    ),
  );
}

async function readCases(path: string): Promise<EvalCase[]> {
  const text = await readText(path);
  const trimmed = text.trim();
  if (!trimmed) fail(`cases file is empty: ${path}`);
  const jsonlLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const rawCases = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : jsonlLines[0]?.startsWith("{")
      ? jsonlLines.map((line) => JSON.parse(line) as unknown)
      : parseCsv(trimmed);
  return rawCases.map(normalizeCase);
}

function selectCases(cases: EvalCase[], opts: EvalOptions): EvalCase[] {
  const filtered =
    opts.caseIds.size === 0
      ? cases
      : cases.filter((entry) => opts.caseIds.has(entry.id));
  if (opts.caseIds.size > 0 && filtered.length !== opts.caseIds.size) {
    const found = new Set(filtered.map((entry) => entry.id));
    const missing = [...opts.caseIds].filter((id) => !found.has(id));
    fail(`case ID(s) not found: ${missing.join(", ")}`);
  }
  if (opts.sample === undefined || opts.sample >= filtered.length) {
    return filtered;
  }
  return [...filtered]
    .sort((a, b) => {
      const aHash = stableHash(`${opts.seed}\0${a.id}`);
      const bHash = stableHash(`${opts.seed}\0${b.id}`);
      return aHash.localeCompare(bHash) || a.id.localeCompare(b.id);
    })
    .slice(0, opts.sample);
}

function evalQuery(query: string): string {
  return [
    "Answer the following hard browsing question.",
    "Write a concise cited Markdown report using reliable sources.",
    "For decisive evidence, prefer exact quotes from fetched sources and preserve source_id plus character spans when available.",
    "Use read_source for important quotes when you need exact source spans.",
    "End with a single final line in this exact format: Final answer: <answer>",
    "Keep the final answer as short as possible so it can be exact-graded.",
    "",
    `Question: ${query}`,
  ].join("\n");
}

function browseCompOutput() {
  return {
    name: "browsecomp_answer",
    schema: {
      type: "object",
      description:
        "Structured answer for a hard browsing question. Use only evidence gathered during the research run.",
      properties: {
        final_answer: {
          type: "string",
          description:
            "Concise exact answer to the question. Avoid aliases or parenthetical details unless they are part of the answer.",
        },
        evidence: {
          type: "array",
          description:
            "Fetched-source evidence supporting the final answer and important clues.",
          items: {
            type: "object",
            properties: {
              clue: {
                type: "string",
                description:
                  "Question clue or answer claim this evidence supports.",
              },
              source_url: {
                type: "string",
                description: "URL of the fetched source.",
              },
              source_id: {
                type: "string",
                description:
                  "source_id returned by fetch for the cited source, such as source_1.",
              },
              quote: {
                type: "string",
                description:
                  "Exact text copied verbatim from the cited source. Character offsets are resolved automatically from this quote.",
              },
            },
            required: ["clue", "source_url", "source_id", "quote"],
            additionalProperties: false,
          },
        },
        unresolved_clues: {
          type: "array",
          description:
            "Important clues that were not verified. Use an empty array when fully verified.",
          items: { type: "string" },
        },
      },
      required: ["final_answer", "evidence", "unresolved_clues"],
      additionalProperties: false,
    },
  };
}

function structuredFinalAnswer(structured: unknown): string | null {
  if (typeof structured !== "object" || structured === null) return null;
  const value = (structured as { final_answer?: unknown }).final_answer;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function structuredEvidence(structured: unknown): unknown[] {
  if (typeof structured !== "object" || structured === null) return [];
  const evidence = (structured as { evidence?: unknown }).evidence;
  return Array.isArray(evidence) ? evidence : [];
}

function readStructuredString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStructuredInteger(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function sourceMatchesUrl(source: SourceDocument, sourceUrl: string): boolean {
  const normalized = normalizeUrlForSource(sourceUrl);
  return (
    normalized === source.canonicalUrl ||
    normalized === normalizeUrlForSource(source.url)
  );
}

function findEvidenceSource(
  sources: SourceDocument[],
  sourceId: string | undefined,
  sourceUrl: string | undefined,
): SourceDocument | undefined {
  if (sourceId) {
    const source = sources.find((entry) => entry.sourceId === sourceId);
    if (source) return source;
  }
  if (sourceUrl) {
    return sources.find((entry) => sourceMatchesUrl(entry, sourceUrl));
  }
  return undefined;
}

function repairStructuredEvidenceSpans(
  structured: unknown,
  sources: SourceDocument[] | undefined,
): unknown {
  if (
    typeof structured !== "object" ||
    structured === null ||
    Array.isArray(structured)
  ) {
    return structured;
  }
  const evidence = structuredEvidence(structured);
  if (evidence.length === 0) return structured;

  const sourceDocuments = sources ?? [];
  const repairedEvidence = evidence.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    const source = findEvidenceSource(
      sourceDocuments,
      readStructuredString(record, "source_id"),
      readStructuredString(record, "source_url"),
    );
    const quote = readStructuredString(record, "quote");
    if (!source || !quote) return entry;

    const preferredStart = readStructuredInteger(record, "start");
    const span = findBestQuoteSpan(source.markdown, quote, preferredStart);
    if (!span) return entry;

    return {
      ...record,
      start: span.start,
      end: span.end,
      quote: source.markdown.slice(span.start, span.end),
    };
  });

  return {
    ...(structured as Record<string, unknown>),
    evidence: repairedEvidence,
  };
}

function findBestQuoteSpan(
  source: string,
  quote: string,
  preferredStart: number | undefined,
): { start: number; end: number } | null {
  const exactMatches = findAllExactMatches(source, quote);
  if (exactMatches.length > 0) {
    const start = chooseClosestStart(exactMatches, preferredStart);
    return { start, end: start + quote.length };
  }
  return findWhitespaceNormalizedSpan(source, quote, preferredStart);
}

function findAllExactMatches(source: string, quote: string): number[] {
  const matches: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= source.length) {
    const index = source.indexOf(quote, fromIndex);
    if (index === -1) break;
    matches.push(index);
    fromIndex = index + Math.max(1, quote.length);
  }
  return matches;
}

function chooseClosestStart(
  starts: number[],
  preferredStart: number | undefined,
): number {
  if (preferredStart === undefined) return starts[0] ?? 0;
  return starts.reduce((best, candidate) =>
    Math.abs(candidate - preferredStart) < Math.abs(best - preferredStart)
      ? candidate
      : best,
  );
}

function findWhitespaceNormalizedSpan(
  source: string,
  quote: string,
  preferredStart: number | undefined,
): { start: number; end: number } | null {
  const normalizedSource = normalizeTextWithOffsets(source);
  const normalizedQuote = normalizeWhitespace(quote);
  if (!normalizedQuote) return null;

  const matches = findAllExactMatches(normalizedSource.text, normalizedQuote);
  if (matches.length === 0) return null;

  const preferredNormalizedStart: number | undefined =
    preferredStart === undefined
      ? undefined
      : normalizedSource.offsets.findIndex(
          (offset) => offset >= preferredStart,
        );
  const normalizedStart = chooseClosestStart(
    matches,
    preferredNormalizedStart !== undefined && preferredNormalizedStart >= 0
      ? preferredNormalizedStart
      : undefined,
  );
  const normalizedEnd = normalizedStart + normalizedQuote.length - 1;
  const start = normalizedSource.offsets[normalizedStart];
  const end = normalizedSource.offsets[normalizedEnd];
  if (start === undefined || end === undefined) return null;
  return { start, end: end + 1 };
}

function normalizeTextWithOffsets(text: string): {
  text: string;
  offsets: number[];
} {
  let normalized = "";
  const offsets: number[] = [];
  let pendingWhitespaceOffset: number | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (normalized && pendingWhitespaceOffset === undefined) {
        pendingWhitespaceOffset = index;
      }
      continue;
    }
    if (pendingWhitespaceOffset !== undefined) {
      normalized += " ";
      offsets.push(pendingWhitespaceOffset);
      pendingWhitespaceOffset = undefined;
    }
    normalized += normalizeComparableChar(char);
    offsets.push(index);
  }
  return { text: normalized, offsets };
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableChar(char: string): string {
  if (char === "‘" || char === "’") return "'";
  if (char === "“" || char === "”") return '"';
  if (/[‐‑‒–—―]/.test(char)) return "-";
  return char;
}

function validateStructuredEvidence(
  structured: unknown,
  sources: SourceDocument[] | undefined,
): EvidenceValidation | undefined {
  const evidence = structuredEvidence(structured);
  if (evidence.length === 0) return undefined;

  const sourceDocuments = sources ?? [];
  const items = evidence.map((entry, index): EvidenceValidationItem => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { index, valid: false, reason: "evidence item is not an object" };
    }

    const record = entry as Record<string, unknown>;
    const clue = readStructuredString(record, "clue");
    const sourceId = readStructuredString(record, "source_id");
    const sourceUrl = readStructuredString(record, "source_url");
    const quote = readStructuredString(record, "quote");
    const start = readStructuredInteger(record, "start");
    const end = readStructuredInteger(record, "end");
    const base: EvidenceValidationItem = {
      index,
      ...(clue ? { clue } : {}),
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(quote ? { quote } : {}),
      valid: false,
    };

    const source = findEvidenceSource(sourceDocuments, sourceId, sourceUrl);
    if (!source) {
      return {
        ...base,
        reason:
          sourceId || sourceUrl
            ? "source not found"
            : "missing source_id/source_url",
      };
    }
    const withSource = { ...base, source_title: source.title };
    if (sourceId && source.sourceId !== sourceId) {
      return {
        ...withSource,
        reason: "source_id does not match fetched source",
      };
    }
    if (sourceUrl && !sourceMatchesUrl(source, sourceUrl)) {
      return {
        ...withSource,
        reason: "source_url does not match fetched source",
      };
    }
    if (!quote) {
      return { ...withSource, reason: "missing quote" };
    }
    if (start === undefined || end === undefined) {
      return { ...withSource, reason: "missing or invalid quote span" };
    }
    if (end <= start || end > source.markdown.length) {
      return { ...withSource, reason: "quote span out of bounds" };
    }

    const spanned = source.markdown.slice(start, end);
    if (spanned !== quote) {
      const quoteIndex = source.markdown.indexOf(quote);
      return {
        ...withSource,
        ...(quoteIndex >= 0 ? { quote_found_elsewhere_at: quoteIndex } : {}),
        reason: "quote does not match source span",
      };
    }

    return { ...withSource, valid: true };
  });

  const valid = items.filter((item) => item.valid).length;
  return {
    checked: items.length,
    valid,
    invalid: items.length - valid,
    items,
  };
}

function extractFinalAnswer(markdown: string): string | null {
  const patterns = [
    /^#{0,6}\s*\*{0,2}final answer\*{0,2}\s*:\s*(.+)$/im,
    /^#{0,6}\s*\*{0,2}exact answer\*{0,2}\s*:\s*(.+)$/im,
    /^#{0,6}\s*answer\s*:\s*(.+)$/im,
  ];
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function normalizeAnswer(answer: string): string {
  return answer
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function gradeAnswer(
  predictedAnswer: string | null,
  expectedAnswers: string[],
): boolean {
  if (!predictedAnswer) return false;
  const predicted = normalizeAnswer(predictedAnswer);
  return expectedAnswers.some(
    (answer) => predicted === normalizeAnswer(answer),
  );
}

function judgePrompt(opts: {
  question: string;
  correctAnswer: string;
  response: string;
}): string {
  return [
    "Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.",
    "",
    `[question]: ${opts.question}`,
    "",
    `[response]: ${opts.response}`,
    "",
    "Your judgement must be in the format and criteria specified below:",
    "",
    "extracted_final_answer: The final exact answer extracted from the [response]. Put the extracted answer as 'None' if there is no exact, final answer to extract from the response.",
    "",
    `[correct_answer]: ${opts.correctAnswer}`,
    "",
    "reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], focusing only on if there are meaningful differences between [correct_answer] and the extracted_final_answer. Do not comment on any background to the problem, do not attempt to solve the problem, do not argue for any answer different than [correct_answer], focus only on whether the answers match.",
    "",
    "correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given above, or is within a small margin of error for numerical problems. Answer 'no' otherwise, i.e. if there if there is any inconsistency, ambiguity, non-equivalency, or if the extracted answer is incorrect.",
    "",
    "confidence: The extracted confidence score between 0% and 100% from [response]. Put 100 if there is no confidence score available.",
  ].join("\n");
}

function readJudgeField(raw: string, field: string): string | null {
  const pattern = new RegExp(`^${field}:\\s*(.*)$`, "im");
  const match = raw.match(pattern);
  return match?.[1]?.trim() || null;
}

function parseJudgeConfidence(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const confidence = Number(match[0]);
  return Number.isFinite(confidence) ? confidence : null;
}

async function judgeResponse(opts: {
  judge: ModelAdapter;
  question: string;
  correctAnswer: string;
  response: string;
  timeoutMs: number;
}): Promise<JudgeResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const resp = await opts.judge.step({
    system:
      "You are a strict evaluator for BrowseComp-style answers. Grade only answer equivalence.",
    messages: [
      {
        role: "user",
        content: judgePrompt({
          question: opts.question,
          correctAnswer: opts.correctAnswer,
          response: opts.response,
        }),
      },
    ],
    maxTokens: 1024,
    signal,
  });
  const raw = resp.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const correctRaw = readJudgeField(raw, "correct")?.toLowerCase() ?? "";
  const extracted = readJudgeField(raw, "extracted_final_answer");
  const confidence = parseJudgeConfidence(readJudgeField(raw, "confidence"));
  return {
    provider: opts.judge.provider,
    model: opts.judge.model,
    correct: /^yes\b/.test(correctRaw),
    extractedFinalAnswer:
      extracted && extracted.toLowerCase() !== "none" ? extracted : null,
    reasoning: readJudgeField(raw, "reasoning") ?? "",
    confidence,
    raw,
  };
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

async function runCase(
  entry: EvalCase,
  opts: EvalOptions,
  judge: ModelAdapter | undefined,
): Promise<EvalResult> {
  const started = Date.now();
  const trace: EvalTraceEvent[] = [];
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    const timeoutSeconds =
      opts.timeoutMs === undefined ? "none" : Math.round(opts.timeoutMs / 1000);
    process.stderr.write(
      `eval:browsecomp: ${entry.id} still running (${elapsedSeconds}s elapsed, timeout=${timeoutSeconds}s)\n`,
    );
  }, 30_000);
  try {
    const run = streamResearch({
      query: evalQuery(entry.query),
      ...resolveModelSpec({
        provider: opts.provider,
        model: opts.model,
        baseUrl: opts.openaiBaseUrl,
      }),
      timeoutMs: opts.timeoutMs,
      tokenLimit: opts.tokenLimit,
      suggestedTeamSize: opts.teamSize,
      output: browseCompOutput(),
      includeSourceDocuments: true,
      browser: steel({ proxy: opts.useProxy }),
      exploreProviderOptions: { anthropic: { thinking: { type: "adaptive" } } },
      finalizeProviderOptions: {
        anthropic: { thinking: { type: "adaptive" }, effort: "high" },
      },
    });
    for await (const event of run.events) {
      trace.push(traceEvent(event, started));
      const line = progressLine(entry.id, event);
      if (line) process.stderr.write(`eval:browsecomp: ${line}\n`);
    }
    const result = await run.result;
    clearInterval(heartbeat);
    const structured =
      result.structured === undefined
        ? undefined
        : repairStructuredEvidenceSpans(
            result.structured,
            result.sourceDocuments,
          );
    const predictedAnswer =
      structuredFinalAnswer(structured) ?? extractFinalAnswer(result.markdown);
    const evidenceValidation = validateStructuredEvidence(
      structured,
      result.sourceDocuments,
    );
    const exactCorrect = gradeAnswer(predictedAnswer, entry.answers);
    let judgeResult: JudgeResult | undefined;
    let judgeError: string | undefined;
    if (judge) {
      try {
        process.stderr.write(
          `eval:browsecomp: ${entry.id}: judging response\n`,
        );
        judgeResult = await judgeResponse({
          judge,
          question: entry.query,
          correctAnswer: entry.answers.join(" OR "),
          response: predictedAnswer
            ? `${result.markdown}\n\nFinal answer: ${predictedAnswer}`
            : result.markdown,
          timeoutMs: opts.judgeTimeoutMs,
        });
      } catch (err) {
        judgeError = err instanceof Error ? err.message : String(err);
      }
    }
    const latencyMs = Date.now() - started;
    const metrics = summarizeRun(result, trace);
    return {
      type: "result",
      id: entry.id,
      query: entry.query,
      expectedAnswers: entry.answers,
      predictedAnswer,
      exactCorrect,
      correct: judgeResult?.correct ?? exactCorrect,
      ...(structured !== undefined ? { structured } : {}),
      ...(evidenceValidation ? { evidenceValidation } : {}),
      ...(judgeResult ? { judge: judgeResult } : {}),
      ...(judgeError ? { judgeError } : {}),
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
      query: entry.query,
      expectedAnswers: entry.answers,
      predictedAnswer: null,
      exactCorrect: false,
      correct: false,
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

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key}:${value}`).join(",");
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
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

function incrementNested(
  counts: Record<string, Record<string, number>>,
  outer: string,
  inner: string,
): void {
  counts[outer] ??= {};
  counts[outer][inner] = (counts[outer][inner] ?? 0) + 1;
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
          if (!attempt.ok) {
            increment(failedAttemptsByMethod, attempt.method);
          }
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

function summarizeSearchDiagnostics(results: EvalResult[]) {
  return results.reduce(
    (summary, result) => {
      const search = result.diagnostics?.search;
      if (!search) return summary;
      summary.events += search.events;
      summary.possibleBatchedGroups += search.possibleBatchedGroups;
      summary.maxQueriesPerGroup = Math.max(
        summary.maxQueriesPerGroup,
        search.maxQueriesPerGroup,
      );
      summary.stringifiedArrayLikeQueries += search.stringifiedArrayLikeQueries;
      return summary;
    },
    {
      events: 0,
      possibleBatchedGroups: 0,
      maxQueriesPerGroup: 0,
      stringifiedArrayLikeQueries: 0,
    },
  );
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
  const correct = results.filter((result) => result.correct).length;
  const exactCorrect = results.filter((result) => result.exactCorrect).length;
  const judged = results.filter((result) => result.judge !== undefined);
  const judgeCorrect = judged.filter((result) => result.judge?.correct).length;
  const totalLeadToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.leadToolCalls ?? 0),
    0,
  );
  const totalSubagentToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.subagentToolCalls ?? 0),
    0,
  );
  const totalToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.totalToolCalls ?? 0),
    0,
  );
  return {
    type: "summary" as const,
    total: results.length,
    completed: completed.length,
    errors: results.length - completed.length,
    correct,
    exactCorrect,
    judged: judged.length,
    judgeCorrect,
    accuracy: results.length === 0 ? 0 : correct / results.length,
    exactAccuracy: results.length === 0 ? 0 : exactCorrect / results.length,
    judgeAccuracy: judged.length === 0 ? null : judgeCorrect / judged.length,
    medianLatencyMs: median(completed.map((result) => result.latencyMs)),
    averageToolCalls:
      completed.length === 0 ? 0 : totalToolCalls / completed.length,
    averageLeadToolCalls:
      completed.length === 0 ? 0 : totalLeadToolCalls / completed.length,
    averageSubagentToolCalls:
      completed.length === 0 ? 0 : totalSubagentToolCalls / completed.length,
    totalToolCalls,
    totalLeadToolCalls,
    totalSubagentToolCalls,
    totalCitationsNotFetched: completed.reduce(
      (sum, result) => sum + (result.metrics?.citationsNotFetched ?? 0),
      0,
    ),
    totalEvidenceChecked: completed.reduce(
      (sum, result) => sum + (result.evidenceValidation?.checked ?? 0),
      0,
    ),
    totalInvalidEvidence: completed.reduce(
      (sum, result) => sum + (result.evidenceValidation?.invalid ?? 0),
      0,
    ),
    searchDiagnostics: summarizeSearchDiagnostics(results),
    fetchHealth: summarizeFetchHealth(results),
    chokeDiagnostics: summarizeChokeDiagnostics(results),
  };
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `eval-runs/browsecomp-${stamp}.jsonl`;
}

function isOfficialBrowseCompCases(casesPath: string): boolean {
  return casesPath === OFFICIAL_BROWSECOMP_CASES_URL;
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(
    resolved,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const cases = await readCases(opts.casesPath);
  const selected = selectCases(cases, opts);
  if (selected.length === 0) fail("no cases selected");

  const manifest = {
    type: "manifest" as const,
    suite: isOfficialBrowseCompCases(opts.casesPath)
      ? "browsecomp"
      : "browsecomp-style",
    casesPath: opts.casesPath,
    seed: opts.seed,
    sample: opts.sample ?? null,
    timeoutMs: opts.timeoutMs ?? null,
    tokenLimit: opts.tokenLimit ?? null,
    teamSize: opts.teamSize ?? null,
    judge: opts.judge,
    judgeProvider: opts.judge
      ? resolveEvalProvider(opts.judgeProvider ?? opts.provider)
      : null,
    judgeModel: opts.judge
      ? resolveEvalModel(
          resolveEvalProvider(opts.judgeProvider ?? opts.provider),
          opts.judgeModel ?? opts.model,
        )
      : null,
    selectedCaseIds: selected.map((entry) => entry.id),
    startedAt: new Date().toISOString(),
  };

  if (opts.dryRun) {
    process.stdout.write(`${selected.map((entry) => entry.id).join("\n")}\n`);
    return;
  }

  const judge = opts.judge ? createJudgeAdapter(opts) : undefined;
  process.stderr.write(
    `eval:browsecomp: running ${selected.length} case(s), seed=${opts.seed}, timeout=${Math.round((opts.timeoutMs ?? 0) / 1000)}s${judge ? `, judge=${judge.provider}/${judge.model}` : ""}\n`,
  );
  const results = await mapWithConcurrency(
    selected,
    opts.concurrency,
    async (entry, index) => {
      process.stderr.write(
        `eval:browsecomp: [${index + 1}/${selected.length}] ${entry.id}\n`,
      );
      return runCase(entry, opts, judge);
    },
  );
  const summary = summarize(results);
  const outPath = opts.outPath ?? defaultOutPath();
  await writeJsonl(outPath, [manifest, ...results, summary]);
  process.stdout.write(
    [
      `cases: ${summary.total}`,
      `accuracy: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total})`,
      `exact accuracy: ${(summary.exactAccuracy * 100).toFixed(1)}% (${summary.exactCorrect}/${summary.total})`,
      summary.judgeAccuracy === null
        ? "judge accuracy: n/a"
        : `judge accuracy: ${(summary.judgeAccuracy * 100).toFixed(1)}% (${summary.judgeCorrect}/${summary.judged})`,
      `errors: ${summary.errors}`,
      `median latency: ${(summary.medianLatencyMs / 1000).toFixed(1)}s`,
      `avg tool calls: ${summary.averageToolCalls.toFixed(1)} (lead ${summary.averageLeadToolCalls.toFixed(1)}, subagent ${summary.averageSubagentToolCalls.toFixed(1)})`,
      `invalid evidence: ${summary.totalInvalidEvidence}/${summary.totalEvidenceChecked}`,
      `search diagnostics: events=${summary.searchDiagnostics.events}, batched=${summary.searchDiagnostics.possibleBatchedGroups}, stringified_arrays=${summary.searchDiagnostics.stringifiedArrayLikeQueries}`,
      `choke diagnostics: budget_subagents=${summary.chokeDiagnostics.budgetExhaustedSubagents}, timeout_subagents=${summary.chokeDiagnostics.timeoutSubagents}, source_errors=${summary.chokeDiagnostics.sourceErrors}, blocked_or_thin=${summary.chokeDiagnostics.blockedOrThinSources}`,
      `fetch health: fetched=${summary.fetchHealth.fetched}, rejected=${summary.fetchHealth.rejected}, methods=${formatCountMap(summary.fetchHealth.fetchedByMethod)}`,
      `results: ${outPath}`,
    ].join("\n") + "\n",
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
