import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

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
const KILL_GRACE_MS = 1_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const TOTAL_OUTPUT_CAP = 8_000;
const STDOUT_TRUNCATE_MARKER = "... [output truncated]";

const RUNNER_SOURCE = String.raw`
const vm = require("node:vm");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: "bad payload" }));
    return;
  }
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const documents = sources.map((s) => ({
    source_id: String(s.source_id || ""),
    url: String(s.url || ""),
    title: String(s.title || ""),
    text: String(s.text || ""),
  }));
  const lines = [];
  let collected = 0;
  let stdoutTruncated = false;
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
    if (stdoutTruncated) return;
    const line = parts.map(printable).join(" ");
    collected += line.length + 1;
    if (collected > 32000) {
      stdoutTruncated = true;
      return;
    }
    lines.push(line);
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
        matches.push({
          source_id: doc.source_id,
          url: doc.url,
          offset: found.index,
          match: text,
          context: contextChars > 0
            ? doc.text.slice(Math.max(0, found.index - contextChars), Math.min(doc.text.length, found.index + text.length + contextChars))
            : "",
        });
        if (text === "") regex.lastIndex++;
      }
      if (matches.length >= max) break;
    }
    return matches;
  };
  const context = {
    sources: documents,
    grep,
    print,
    console: { log: print },
  };
  let completion;
  let error;
  try {
    completion = vm.runInNewContext(String(payload.code || ""), context, {
      timeout: Math.max(1, Math.floor(Number(payload.timeoutMs) || 5000)),
      displayErrors: false,
    });
  } catch (err) {
    const message = err && typeof err.message === "string" ? err.message : String(err);
    error = /timed out|ERR_SCRIPT_EXECUTION_TIMEOUT/i.test(message)
      ? "code timed out"
      : "code threw: " + message;
  }
  let result;
  if (error === undefined && completion !== undefined && typeof completion !== "function" && typeof completion !== "symbol") {
    try {
      const json = JSON.stringify(completion);
      if (json !== undefined && json.length <= 4000) result = JSON.parse(json);
    } catch {}
  }
  process.stdout.write(JSON.stringify({
    sources_in_scope: documents.length,
    stdout: lines.join("\n"),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(stdoutTruncated ? { truncated: true } : {}),
  }));
});
`;

export function clampSandboxTimeout(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

export async function runCodeSandboxed(
  req: SandboxRequest,
): Promise<SandboxOutput> {
  const payload = JSON.stringify({
    code: req.code,
    sources: req.sources,
    timeoutMs: req.timeoutMs,
  });
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    return {
      sources_in_scope: req.sources.length,
      stdout: "",
      error: `sources too large for the sandbox (limit ${MAX_PAYLOAD_BYTES} bytes); restrict source_ids`,
    };
  }

  return new Promise<SandboxOutput>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", "-e", RUNNER_SOURCE],
      {
        cwd: tmpdir(),
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let stdout = "";
    let settled = false;
    const finish = (output: SandboxOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(output);
    };
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        sources_in_scope: req.sources.length,
        stdout: "",
        error: `code timed out after ${req.timeoutMs}ms`,
      });
    }, req.timeoutMs + KILL_GRACE_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (err) => {
      finish({
        sources_in_scope: req.sources.length,
        stdout: "",
        error: `sandbox failed to start: ${err.message}`,
      });
    });
    child.on("close", () => {
      try {
        finish(JSON.parse(stdout) as SandboxOutput);
      } catch {
        finish({
          sources_in_scope: req.sources.length,
          stdout: "",
          error: "sandbox produced no parseable output",
        });
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
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
