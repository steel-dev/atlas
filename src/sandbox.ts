export interface SandboxSource {
  source_id: string;
  url: string;
  title: string;
  text: string;
}

export interface SandboxRequest {
  code: string;
  sources: SandboxSource[];
  timeoutMs: number;
}

export interface SandboxOutput {
  sources_in_scope: number;
  stdout: string;
  result?: unknown;
  error?: string;
  truncated?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MEMORY_LIMIT_MB = 128;
const TOTAL_OUTPUT_CAP = 8_000;
const STDOUT_TRUNCATE_MARKER = "... [output truncated]";

interface IvmReference {
  set(key: string, value: unknown): Promise<void>;
}

interface IvmContext {
  global: IvmReference;
}

interface IvmScript {
  run(
    context: IvmContext,
    options?: { timeout?: number; copy?: boolean },
  ): Promise<unknown>;
}

interface IvmExternalCopy {
  copyInto(options?: { release?: boolean }): unknown;
}

interface IvmIsolate {
  createContext(): Promise<IvmContext>;
  compileScript(code: string): Promise<IvmScript>;
  dispose(): void;
}

interface IsolatedVM {
  Isolate: new (options?: { memoryLimit?: number }) => IvmIsolate;
  ExternalCopy: new (value: unknown) => IvmExternalCopy;
}

let isolatedVmPromise: Promise<IsolatedVM | null> | null = null;

function loadIsolatedVm(): Promise<IsolatedVM | null> {
  isolatedVmPromise ??= import("isolated-vm").then(
    (mod) =>
      (mod as { default?: IsolatedVM }).default ??
      (mod as unknown as IsolatedVM),
    () => null,
  );
  return isolatedVmPromise;
}

export async function isRunCodeAvailable(): Promise<boolean> {
  return (await loadIsolatedVm()) !== null;
}

const RUNNER_SCRIPT = String.raw`
const documents = Array.isArray(globalThis.sources) ? globalThis.sources : [];
const __lines = [];
let __collected = 0;
let __truncated = false;
const printable = (value) => {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
};
const print = (...parts) => {
  if (__truncated) return;
  const line = parts.map(printable).join(" ");
  __collected += line.length + 1;
  if (__collected > 32000) {
    __truncated = true;
    return;
  }
  __lines.push(line);
};
const grep = (pattern, opts) => {
  const options = opts && typeof opts === "object" ? opts : {};
  const isRegExp = Object.prototype.toString.call(pattern) === "[object RegExp]";
  const source = isRegExp ? pattern.source : String(pattern ?? "");
  if (!source) throw new Error("grep: pattern must be a non-empty string or RegExp");
  const baseFlags = isRegExp ? pattern.flags : "";
  const flags = [...new Set([...baseFlags, "g", ...(options.ignore_case === true ? ["i"] : [])])].join("");
  const regex = new RegExp(source, flags);
  const wanted = Array.isArray(options.source_ids) && options.source_ids.length > 0
    ? new Set(options.source_ids.map((id) => String(id ?? "").trim()))
    : null;
  const scope = wanted ? documents.filter((d) => wanted.has(d.source_id)) : documents;
  const maxRaw = Math.floor(Number(options.max));
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 200) : 50;
  const ctxRaw = options.context === true ? 80 : Math.floor(Number(options.context));
  const contextChars = Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.min(ctxRaw, 500) : 0;
  const matches = [];
  for (const doc of scope) {
    regex.lastIndex = 0;
    let found;
    while (matches.length < max && (found = regex.exec(doc.text)) !== null) {
      const text = found[0];
      const ctxStr = contextChars > 0
        ? doc.text.slice(Math.max(0, found.index - contextChars), Math.min(doc.text.length, found.index + text.length + contextChars))
        : "";
      matches.push({
        source_id: doc.source_id,
        url: doc.url,
        offset: found.index,
        match: text,
        text: ctxStr || text,
        context: ctxStr,
      });
      if (text === "") regex.lastIndex++;
    }
    if (matches.length >= max) break;
  }
  return matches;
};
globalThis.print = print;
globalThis.grep = grep;
globalThis.console = { log: print };
let __result;
let __error;
try {
  __result = (0, eval)(String(globalThis.__code || ""));
} catch (err) {
  const message = err && typeof err.message === "string" ? err.message : String(err);
  __error = "code threw: " + message;
}
let __resultJSON;
if (__error === undefined && __result !== undefined && typeof __result !== "function" && typeof __result !== "symbol") {
  try {
    const json = JSON.stringify(__result);
    if (json !== undefined && json.length <= 4000) __resultJSON = json;
  } catch {}
}
JSON.stringify({
  stdout: __lines.join("\n"),
  ...(__resultJSON !== undefined ? { resultJSON: __resultJSON } : {}),
  ...(__error !== undefined ? { error: __error } : {}),
  ...(__truncated ? { truncated: true } : {}),
});
`;

export function clampSandboxTimeout(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

function hostErrorOutput(err: unknown, req: SandboxRequest): SandboxOutput {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|execution timed out|timeout/i.test(message)) {
    return {
      sources_in_scope: req.sources.length,
      stdout: "",
      error: `code timed out after ${req.timeoutMs}ms`,
    };
  }
  if (/memory limit|isolate was disposed|array buffer allocation/i.test(message)) {
    return {
      sources_in_scope: req.sources.length,
      stdout: "",
      error: "code exceeded the sandbox memory limit",
    };
  }
  return {
    sources_in_scope: req.sources.length,
    stdout: "",
    error: `sandbox error: ${message}`,
  };
}

export async function runCodeSandboxed(
  req: SandboxRequest,
): Promise<SandboxOutput> {
  const ivm = await loadIsolatedVm();
  if (!ivm) {
    return {
      sources_in_scope: req.sources.length,
      stdout: "",
      error:
        'run_code is unavailable: the optional "isolated-vm" dependency is not installed or failed to build. Run `npm install isolated-vm` to enable the sandbox.',
    };
  }

  const documents = req.sources.map((source) => ({
    source_id: String(source.source_id ?? ""),
    url: String(source.url ?? ""),
    title: String(source.title ?? ""),
    text: String(source.text ?? ""),
  }));

  let payloadBytes = 0;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(documents), "utf8");
  } catch {
    payloadBytes = 0;
  }
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return {
      sources_in_scope: documents.length,
      stdout: "",
      error: `sources too large for the sandbox (limit ${MAX_PAYLOAD_BYTES} bytes); restrict source_ids`,
    };
  }

  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = await isolate.createContext();
    await context.global.set(
      "sources",
      new ivm.ExternalCopy(documents).copyInto({ release: true }),
    );
    await context.global.set("__code", req.code);
    const script = await isolate.compileScript(RUNNER_SCRIPT);
    const raw = await script.run(context, {
      timeout: req.timeoutMs,
      copy: true,
    });
    let summary: {
      stdout?: string;
      resultJSON?: string;
      error?: string;
      truncated?: boolean;
    };
    try {
      summary = JSON.parse(String(raw));
    } catch {
      return {
        sources_in_scope: documents.length,
        stdout: "",
        error: "sandbox produced no parseable output",
      };
    }
    const output: SandboxOutput = {
      sources_in_scope: documents.length,
      stdout: summary.stdout ?? "",
    };
    if (summary.resultJSON !== undefined) {
      try {
        output.result = JSON.parse(summary.resultJSON);
      } catch {}
    }
    if (summary.error !== undefined) output.error = summary.error;
    if (summary.truncated) output.truncated = true;
    return output;
  } catch (err) {
    return hostErrorOutput(err, req);
  } finally {
    try {
      isolate.dispose();
    } catch {}
  }
}

export function shapeSandboxOutput(payload: SandboxOutput): string {
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
