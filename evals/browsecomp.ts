import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../src/defaults.js";
import { createAISdkModelAdapter, type ModelAdapter } from "../src/model.js";
import { type ModelProvider } from "../src/research.js";
import { Atlas } from "../src/atlas.js";
import { steel } from "../src/steel.js";
import { resolveModelSpec } from "../src/config-resolution.js";
import {
  buildDiagnostics,
  formatCountMap,
  mapWithConcurrency,
  median,
  progressLine,
  readEnv,
  stableHash,
  summarizeRun,
  traceEvent,
  writeJsonl,
  type EvalDiagnostics,
  type EvalTraceEvent,
  type RunMetrics,
} from "./lib.js";

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
  provider?: ModelProvider;
  model?: string;
  judge: boolean;
  judgeProvider?: ModelProvider;
  judgeModel?: string;
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

interface EvalResult {
  type: "result";
  id: string;
  query: string;
  expectedAnswers: string[];
  predictedAnswer: string | null;
  exactCorrect: boolean;
  correct: boolean;
  judge?: JudgeResult;
  judgeError?: string;
  error?: string;
  finishReason?: string;
  markdown?: string;
  latencyMs: number;
  trace: EvalTraceEvent[];
  diagnostics?: EvalDiagnostics;
  metrics?: RunMetrics;
}

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
      --provider NAME      Model provider: anthropic, openai
      --model NAME         Model name
      --judge              Grade responses with an LLM judge
      --judge-provider P   Judge provider: anthropic, openai (default: anthropic, independent of the model under test)
      --judge-model MODEL  Judge model (default: claude-opus-4-8 for anthropic)
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
  model: string;
}): ModelAdapter {
  const provider = createOpenAI({
    apiKey: opts.apiKey,
  });
  return createAISdkModelAdapter({
    model: provider(opts.model),
    provider: "openai",
    modelId: opts.model,
  });
}

const DEFAULT_JUDGE_PROVIDER: ModelProvider = "anthropic";

function defaultJudgeModel(provider: ModelProvider): string {
  return provider === "openai" ? DEFAULT_OPENAI_MODEL : "claude-opus-4-8";
}

function createJudgeAdapter(opts: EvalOptions): ModelAdapter {
  const provider = resolveEvalProvider(
    opts.judgeProvider ?? DEFAULT_JUDGE_PROVIDER,
  );
  const model = opts.judgeModel?.trim() || defaultJudgeModel(provider);
  const runProvider = resolveEvalProvider(opts.provider);
  const runModel = resolveEvalModel(runProvider, opts.model);
  if (provider === runProvider && model === runModel) {
    process.stderr.write(
      `warning: judge ${provider}/${model} is the model under test; self-grading inflates scores — pass --judge-model for an independent judge\n`,
    );
  }
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
  return createOpenAIModelAdapter({ apiKey, model });
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
  const decoded = Buffer.from(
    encrypted.map((byte, index) => byte ^ key[index]),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
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
    } catch (err) {
      fail(
        `browsecomp: failed to decrypt "${field}" with the row canary; refusing to grade ciphertext (dataset or canary mismatch): ${err instanceof Error ? err.message : String(err)}`,
      );
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
    const atlas = new Atlas({
      ...(await resolveModelSpec({
        provider: opts.provider,
        model: opts.model,
      })),
      browser: steel({ proxy: opts.useProxy }),
    });
    const run = atlas.stream(evalQuery(entry.query), {
      timeoutMs: opts.timeoutMs,
      tokenLimit: opts.tokenLimit,
      includeSourceDocuments: true,
      exploreProviderOptions: {
        anthropic: { thinking: { type: "adaptive" }, effort: "max" },
        openai: { reasoningEffort: "high" },
      },
      finalizeProviderOptions: {
        anthropic: { thinking: { type: "adaptive" }, effort: "max" },
        openai: { reasoningEffort: "high" },
      },
    });
    for await (const event of run.events) {
      const traced = traceEvent(event, started);
      if (traced) trace.push(traced);
      const line = progressLine(entry.id, event);
      if (line) process.stderr.write(`eval:browsecomp: ${line}\n`);
    }
    const result = await run.result;
    clearInterval(heartbeat);
    const predictedAnswer = extractFinalAnswer(result.markdown);
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
    const metrics = summarizeRun(result);
    return {
      type: "result",
      id: entry.id,
      query: entry.query,
      expectedAnswers: entry.answers,
      predictedAnswer,
      exactCorrect,
      correct: judgeResult?.correct ?? exactCorrect,
      ...(judgeResult ? { judge: judgeResult } : {}),
      ...(judgeError ? { judgeError } : {}),
      finishReason: result.finishReason,
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
      summary.confirmed += claims.confirmed;
      summary.refuted += claims.refuted;
      return summary;
    },
    { extracted: 0, unsupported: 0, confirmed: 0, refuted: 0 },
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
  const totalSurveys = completed.reduce(
    (sum, result) => sum + (result.metrics?.surveys ?? 0),
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
    averageLeadToolCalls:
      completed.length === 0 ? 0 : totalLeadToolCalls / completed.length,
    averageSurveys:
      completed.length === 0 ? 0 : totalSurveys / completed.length,
    totalCitationsNotFetched: completed.reduce(
      (sum, result) => sum + (result.metrics?.citationsNotFetched ?? 0),
      0,
    ),
    claimHealth: summarizeClaimHealth(results),
    fetchHealth: summarizeFetchHealth(results),
  };
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `eval-runs/browsecomp-${stamp}.jsonl`;
}

function isOfficialBrowseCompCases(casesPath: string): boolean {
  return casesPath === OFFICIAL_BROWSECOMP_CASES_URL;
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
      `avg lead tool calls: ${summary.averageLeadToolCalls.toFixed(1)} (surveys ${summary.averageSurveys.toFixed(1)})`,
      `claims: extracted=${summary.claimHealth.extracted}, unsupported=${summary.claimHealth.unsupported}, confirmed=${summary.claimHealth.confirmed}, refuted=${summary.claimHealth.refuted}`,
      `fetch health: fetched=${summary.fetchHealth.fetched}, rejected=${summary.fetchHealth.rejected}, blocked_or_thin=${summary.fetchHealth.blockedOrThin}, methods=${formatCountMap(summary.fetchHealth.fetchedByMethod)}`,
      `results: ${outPath}`,
    ].join("\n") + "\n",
  );
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
