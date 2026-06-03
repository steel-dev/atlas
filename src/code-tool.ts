import { runInNewContext } from "node:vm";
import type { ResearchCtx } from "./runtime.js";
import type { SourceDocument } from "./sources.js";
import { documentsForSearch } from "./evidence-tool.js";
import { errorMessage } from "./errors.js";

export interface RunCodeToolInput {
  code?: string;
  source_ids?: string[];
  timeout_ms?: number;
}

interface GrepOptions {
  source_ids?: string[];
  ignore_case?: boolean;
  context?: number | boolean;
  max?: number;
}

interface GrepMatch {
  source_id: string;
  url: string;
  offset: number;
  match: string;
  context: string;
}

interface RunCodeOutput {
  sources_in_scope: number;
  stdout: string;
  result?: unknown;
  error?: string;
  truncated?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const TOTAL_OUTPUT_CAP = 8_000;
const STDOUT_COLLECTION_CAP = TOTAL_OUTPUT_CAP * 4;
const STDOUT_TRUNCATE_MARKER = "... [output truncated]";
const DEFAULT_GREP_MAX = 50;
const MAX_GREP_MAX = 200;
const GREP_CONTEXT_CHARS = 80;
const RESULT_MAX_CHARS = 4_000;

function clampTimeout(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

function isRegExpLike(value: unknown): value is RegExp {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object RegExp]"
  );
}

function buildGrepRegex(pattern: unknown, ignoreCase: boolean): RegExp {
  const regexLike = isRegExpLike(pattern);
  const source = regexLike ? pattern.source : String(pattern ?? "");
  if (!source) {
    throw new Error("grep: pattern must be a non-empty string or RegExp");
  }
  const baseFlags = regexLike ? pattern.flags : "";
  const flags = [
    ...new Set([...baseFlags, "g", ...(ignoreCase ? ["i"] : [])]),
  ].join("");
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(`grep: invalid regex: ${errorMessage(err)}`);
  }
}

function clampGrepMax(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GREP_MAX;
  return Math.min(n, MAX_GREP_MAX);
}

function grepContextChars(raw: GrepOptions["context"]): number {
  if (raw === true) return GREP_CONTEXT_CHARS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 500);
}

function grepScope(
  documents: SourceDocument[],
  sourceIds: unknown,
): SourceDocument[] {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return documents;
  const wanted = new Set(sourceIds.map((id) => String(id ?? "").trim()));
  return documents.filter((document) => wanted.has(document.sourceId));
}

function createGrep(documents: SourceDocument[]) {
  return (pattern: unknown, opts?: GrepOptions): GrepMatch[] => {
    const options = opts && typeof opts === "object" ? opts : {};
    const regex = buildGrepRegex(pattern, options.ignore_case === true);
    const scope = grepScope(documents, options.source_ids);
    const max = clampGrepMax(options.max);
    const contextChars = grepContextChars(options.context);
    const matches: GrepMatch[] = [];
    for (const document of scope) {
      regex.lastIndex = 0;
      let found: RegExpExecArray | null;
      while (
        matches.length < max &&
        (found = regex.exec(document.markdown)) !== null
      ) {
        const text = found[0];
        matches.push({
          source_id: document.sourceId,
          url: document.url,
          offset: found.index,
          match: text,
          context:
            contextChars > 0
              ? document.markdown.slice(
                  Math.max(0, found.index - contextChars),
                  Math.min(
                    document.markdown.length,
                    found.index + text.length + contextChars,
                  ),
                )
              : "",
        });
        if (text === "") regex.lastIndex++;
      }
      if (matches.length >= max) break;
    }
    return matches;
  };
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function createPrinter(): {
  print: (...parts: unknown[]) => void;
  lines: string[];
  wasTruncated: () => boolean;
} {
  const lines: string[] = [];
  let collected = 0;
  let truncated = false;
  const print = (...parts: unknown[]): void => {
    if (truncated) return;
    const line = parts.map(printable).join(" ");
    collected += line.length + 1;
    if (collected > STDOUT_COLLECTION_CAP) {
      truncated = true;
      return;
    }
    lines.push(line);
  };
  return { print, lines, wasTruncated: () => truncated };
}

function runSandbox(req: {
  code: string;
  context: Record<string, unknown>;
  timeoutMs: number;
}): { completion: unknown } {
  return {
    completion: runInNewContext(req.code, req.context, {
      timeout: req.timeoutMs,
      displayErrors: false,
    }),
  };
}

function thrownMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as Error).message === "string"
  ) {
    return (err as Error).message;
  }
  return String(err);
}

function isTimeoutError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
    return true;
  }
  return /timed out/i.test(thrownMessage(err));
}

function serializeResult(completion: unknown): unknown {
  if (
    completion === undefined ||
    typeof completion === "function" ||
    typeof completion === "symbol"
  ) {
    return undefined;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(completion);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length > RESULT_MAX_CHARS) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function shapeOutput(payload: RunCodeOutput): string {
  let body = payload;
  let json = JSON.stringify(body, null, 2);
  if (json.length <= TOTAL_OUTPUT_CAP) return json;
  if ("result" in body) {
    const { result: _dropped, ...rest } = body;
    body = { ...rest, truncated: true };
    json = JSON.stringify(body, null, 2);
    if (json.length <= TOTAL_OUTPUT_CAP) return json;
  }
  const overhead = JSON.stringify(
    { ...body, stdout: "", truncated: true },
    null,
    2,
  ).length;
  const room = Math.max(
    0,
    TOTAL_OUTPUT_CAP - overhead - STDOUT_TRUNCATE_MARKER.length - 4,
  );
  body = {
    ...body,
    stdout: `${body.stdout.slice(0, room)}\n${STDOUT_TRUNCATE_MARKER}`,
    truncated: true,
  };
  return JSON.stringify(body, null, 2);
}

export function execRunCode(args: RunCodeToolInput, ctx: ResearchCtx): string {
  const code = String(args.code ?? "").trim();
  if (!code) return "Error: run_code requires non-empty `code`.";

  const timeoutMs = clampTimeout(args.timeout_ms);
  const documents = documentsForSearch(ctx, args.source_ids);
  if (typeof documents === "string") return documents;
  if (documents.length === 0) {
    return "Error: no fetched source documents are available to run code over.";
  }

  const sources = documents.map((document) => ({
    source_id: document.sourceId,
    url: document.url,
    title: document.title,
    text: document.markdown,
  }));
  const printer = createPrinter();
  const context: Record<string, unknown> = {
    sources,
    grep: createGrep(documents),
    print: printer.print,
    console: { log: printer.print },
  };

  try {
    const { completion } = runSandbox({ code, context, timeoutMs });
    const result = serializeResult(completion);
    return shapeOutput({
      sources_in_scope: documents.length,
      stdout: printer.lines.join("\n"),
      ...(result !== undefined ? { result } : {}),
      ...(printer.wasTruncated() ? { truncated: true } : {}),
    });
  } catch (err) {
    const error = isTimeoutError(err)
      ? `code timed out after ${timeoutMs}ms`
      : `code threw: ${thrownMessage(err)}`;
    return shapeOutput({
      sources_in_scope: documents.length,
      stdout: printer.lines.join("\n"),
      error,
    });
  }
}
