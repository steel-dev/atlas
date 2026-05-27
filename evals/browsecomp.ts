import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  research,
  type ModelProvider,
  type ResearchEffort,
  type ResearchEvent,
  type ResearchResult,
} from "../src/research.js";

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
  effort?: ResearchEffort;
  provider?: ModelProvider;
  model?: string;
  openaiBaseUrl?: string;
  concurrency: number;
  useProxy: boolean;
  dryRun: boolean;
}

interface EvalResult {
  type: "result";
  id: string;
  query: string;
  expectedAnswers: string[];
  predictedAnswer: string | null;
  correct: boolean;
  error?: string;
  latencyMs: number;
  trace: EvalTraceEvent[];
  metrics?: {
    provider: ModelProvider;
    model: string;
    toolCalls: number;
    fetchedUrls: string[];
    verifiedSources: number;
    unverifiedCitations: number;
    inputTokens: number;
    outputTokens: number;
  };
}

type EvalTraceEvent = {
  atMs: number;
  event: ResearchEvent["type"];
  index?: number;
  query?: string;
  count?: number;
  url?: string;
  title?: string;
  error?: string;
  retryAfterSeconds?: number;
  attempt?: number;
  maxAttempts?: number;
  sourcesFetched?: number;
  markdownChars?: number;
  result?: {
    verifiedSources: number;
    unverifiedCitations: number;
    markdownChars: number;
  };
};

const DEFAULT_CASES_PATH = "evals/cases/browsecomp.jsonl";
const DEFAULT_TIMEOUT_MS = 300_000;

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
      --effort LEVEL       Research effort: low, medium, high, max
      --provider NAME      Model provider: anthropic, openai
      --model NAME         Model name
      --base-url URL       OpenAI-compatible base URL
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

function readEffort(raw: string): ResearchEffort {
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "max") {
    return raw;
  }
  fail(`--effort must be one of: low, medium, high, max (got "${raw}")`);
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
      opts.timeoutMs = Math.floor(readPositiveNumber(readValue(argv, i, arg), arg) * 1000);
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
    if (arg === "--base-url") {
      opts.openaiBaseUrl = readValue(argv, i, arg);
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

function deriveKey(password: string, length: number): Buffer {
  const digest = createHash("sha256").update(password).digest();
  const chunks: Buffer[] = [];
  while (Buffer.concat(chunks).length < length) chunks.push(digest);
  return Buffer.concat(chunks).subarray(0, length);
}

function decryptBrowseCompValue(value: string, canary: string): string {
  const encrypted = Buffer.from(value, "base64");
  const key = deriveKey(canary, encrypted.length);
  return Buffer.from(encrypted.map((byte, index) => byte ^ key[index])).toString(
    "utf8",
  );
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
  return expectedAnswers.some((answer) => predicted === normalizeAnswer(answer));
}

function summarizeRun(result: ResearchResult): EvalResult["metrics"] {
  return {
    provider: result.provider,
    model: result.model,
    toolCalls: result.runs.reduce((sum, run) => sum + run.toolCalls, 0),
    fetchedUrls: result.runs.flatMap((run) => run.fetchedUrls),
    verifiedSources: result.verifiedSources.length,
    unverifiedCitations: result.unverifiedCitations.length,
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
      return `${caseId}: fetched ${event.url}`;
    case "source_error":
      return `${caseId}: source error ${event.url}: ${event.error}`;
    case "rate_limited":
      return `${caseId}: rate limited, waiting ${event.retryAfterSeconds}s`;
    case "research_finished":
      return `${caseId}: research finished with ${event.sourcesFetched} source(s)`;
    case "unverified_citations":
      return `${caseId}: ${event.count} unverified citation(s)`;
    case "written":
      return `${caseId}: wrote ${event.markdownChars} markdown chars`;
    case "completed":
    case "research_started":
      return null;
  }
}

function traceEvent(event: ResearchEvent, started: number): EvalTraceEvent {
  const base = { atMs: Date.now() - started, event: event.type };
  switch (event.type) {
    case "searching":
      return { ...base, index: event.index, query: event.query };
    case "search_results":
      return { ...base, index: event.index, count: event.count };
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
      return { ...base, url: event.url, title: event.title };
    case "source_error":
      return { ...base, url: event.url, error: event.error };
    case "research_finished":
      return { ...base, sourcesFetched: event.sourcesFetched };
    case "unverified_citations":
      return { ...base, count: event.count };
    case "written":
      return { ...base, markdownChars: event.markdownChars };
    case "completed":
      return {
        ...base,
        result: {
          verifiedSources: event.result.verifiedSources.length,
          unverifiedCitations: event.result.unverifiedCitations.length,
          markdownChars: event.result.markdown.length,
        },
      };
    case "research_started":
      return base;
  }
}

async function runCase(entry: EvalCase, opts: EvalOptions): Promise<EvalResult> {
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
    const result = await research({
      query: evalQuery(entry.query),
      provider: opts.provider,
      model: opts.model,
      openaiBaseUrl: opts.openaiBaseUrl,
      timeoutMs: opts.timeoutMs,
      effort: opts.effort,
      useProxy: opts.useProxy,
      onEvent: (event) => {
        trace.push(traceEvent(event, started));
        const line = progressLine(entry.id, event);
        if (line) process.stderr.write(`eval:browsecomp: ${line}\n`);
      },
    });
    clearInterval(heartbeat);
    const predictedAnswer = extractFinalAnswer(result.markdown);
    return {
      type: "result",
      id: entry.id,
      query: entry.query,
      expectedAnswers: entry.answers,
      predictedAnswer,
      correct: gradeAnswer(predictedAnswer, entry.answers),
      latencyMs: Date.now() - started,
      trace,
      metrics: summarizeRun(result),
    };
  } catch (err) {
    clearInterval(heartbeat);
    return {
      type: "result",
      id: entry.id,
      query: entry.query,
      expectedAnswers: entry.answers,
      predictedAnswer: null,
      correct: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
      trace,
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

function summarize(results: EvalResult[]) {
  const completed = results.filter((result) => !result.error);
  const correct = results.filter((result) => result.correct).length;
  const totalToolCalls = completed.reduce(
    (sum, result) => sum + (result.metrics?.toolCalls ?? 0),
    0,
  );
  return {
    type: "summary" as const,
    total: results.length,
    completed: completed.length,
    errors: results.length - completed.length,
    correct,
    accuracy: results.length === 0 ? 0 : correct / results.length,
    medianLatencyMs: median(completed.map((result) => result.latencyMs)),
    averageToolCalls:
      completed.length === 0 ? 0 : totalToolCalls / completed.length,
    totalUnverifiedCitations: completed.reduce(
      (sum, result) => sum + (result.metrics?.unverifiedCitations ?? 0),
      0,
    ),
  };
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `eval-runs/browsecomp-${stamp}.jsonl`;
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
    suite: "browsecomp-style",
    casesPath: opts.casesPath,
    seed: opts.seed,
    sample: opts.sample ?? null,
    timeoutMs: opts.timeoutMs ?? null,
    effort: opts.effort ?? null,
    selectedCaseIds: selected.map((entry) => entry.id),
    startedAt: new Date().toISOString(),
  };

  if (opts.dryRun) {
    process.stdout.write(
      `${selected.map((entry) => entry.id).join("\n")}\n`,
    );
    return;
  }

  process.stderr.write(
    `eval:browsecomp: running ${selected.length} case(s), seed=${opts.seed}, timeout=${Math.round((opts.timeoutMs ?? 0) / 1000)}s\n`,
  );
  const results = await mapWithConcurrency(
    selected,
    opts.concurrency,
    async (entry, index) => {
      process.stderr.write(
        `eval:browsecomp: [${index + 1}/${selected.length}] ${entry.id}\n`,
      );
      return runCase(entry, opts);
    },
  );
  const summary = summarize(results);
  const outPath = opts.outPath ?? defaultOutPath();
  await writeJsonl(outPath, [manifest, ...results, summary]);
  process.stdout.write(
    [
      `cases: ${summary.total}`,
      `accuracy: ${(summary.accuracy * 100).toFixed(1)}% (${summary.correct}/${summary.total})`,
      `errors: ${summary.errors}`,
      `median latency: ${(summary.medianLatencyMs / 1000).toFixed(1)}s`,
      `avg tool calls: ${summary.averageToolCalls.toFixed(1)}`,
      `results: ${outPath}`,
    ].join("\n") + "\n",
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
