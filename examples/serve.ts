#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { parseArgs } from "node:util";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODEL,
} from "../src/defaults.js";
import { readEnv } from "../src/env.js";
import { Atlas, type AtlasConfig, type Effort } from "../src/index.js";

const USAGE = `atlas serve — minimal local web UI for deep research

Usage:
  tsx examples/serve.ts [options]

Options:
      --port N          Port to listen on (default: 4317)
      --host HOST       Host to bind (default: 127.0.0.1)
      --provider NAME   anthropic | openai | zai (default: ATLAS_PROVIDER or anthropic)
      --model ID        Model id (default: ATLAS_MODEL or provider default)
  -h, --help            Show this help

API:
  POST /research {"question": "...", "effort": "balanced"}
    → SSE stream of research events, ending with {"type":"result","result":...}
`;

function fail(message: string): never {
  process.stderr.write(`atlas-serve: ${message}\n`);
  process.exit(1);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeProvider(provider: string): "anthropic" | "openai" | "zai" {
  if (provider === "anthropic" || provider === "openai") return provider;
  if (provider === "zai" || provider === "z.ai" || provider === "zhipu") {
    return "zai";
  }
  fail(`provider must be one of: anthropic, openai, zai (got "${provider}")`);
}

function resolveModel(
  providerFlag: string | undefined,
  modelFlag: string | undefined,
): AtlasConfig["model"] {
  const provider = normalizeProvider(
    providerFlag ?? readEnv("ATLAS_PROVIDER") ?? "anthropic",
  );
  const modelId =
    modelFlag ??
    readEnv("ATLAS_MODEL") ??
    (provider === "anthropic"
      ? DEFAULT_ANTHROPIC_MODEL
      : provider === "openai"
        ? DEFAULT_OPENAI_MODEL
        : DEFAULT_ZAI_MODEL);
  if (provider === "anthropic") {
    const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
    if (!apiKey) fail("ANTHROPIC_API_KEY is required for provider=anthropic");
    return createAnthropic({ apiKey })(modelId);
  }
  if (provider === "zai") {
    const apiKey = readEnv("ATLAS_ZAI_API_KEY", "ZAI_API_KEY");
    if (!apiKey) fail("ZAI_API_KEY is required for provider=zai");
    const baseURL =
      readEnv("ATLAS_ZAI_BASE_URL", "ZAI_BASE_URL") ?? DEFAULT_ZAI_BASE_URL;
    return createOpenAI({ apiKey, baseURL }).chat(modelId);
  }
  const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
  if (!apiKey) fail("OPENAI_API_KEY is required for provider=openai");
  return createOpenAI({ apiKey })(modelId);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseEffort(raw: unknown): Effort | undefined {
  if (raw === "fast" || raw === "balanced" || raw === "deep" || raw === "max") {
    return raw;
  }
  return undefined;
}

async function handleResearch(
  atlas: Atlas,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req).catch(() => "");
  let question = "";
  let effort: Effort | undefined;
  try {
    const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
    if (typeof parsed.question === "string") question = parsed.question.trim();
    effort = parseEffort(parsed.effort);
  } catch {
    question = "";
  }
  if (!question) {
    sendJson(res, 400, { error: "question is required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const run = atlas.start(question, effort ? { effort } : {});
  let finished = false;
  res.on("close", () => {
    if (!finished) void run.abort();
  });

  const send = (payload: unknown) =>
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    for await (const event of run.events()) send(event);
    const result = await run.result();
    send({ type: "result", result });
  } catch (err) {
    send({ type: "run.error", message: messageOf(err), recoverable: false });
  } finally {
    finished = true;
    res.end();
  }
}

function page(): string {
  return readFileSync(new URL("./serve.page.html", import.meta.url), "utf8");
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    void 0;
  }
  const { values } = (() => {
    try {
      return parseArgs({
        args: process.argv.slice(2),
        allowPositionals: false,
        options: {
          port: { type: "string" },
          host: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (err) {
      fail(messageOf(err));
    }
  })();

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`--port must be a valid port 0-65535 (got "${values.port}")`);
  }
  const host = values.host ?? "127.0.0.1";

  const atlas = new Atlas({
    model: resolveModel(values.provider, values.model),
  });

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page());
      return;
    }
    if (req.method === "POST" && path === "/research") {
      void handleResearch(atlas, req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: messageOf(err) });
        else res.end();
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  process.stderr.write(`atlas-serve: web UI on http://${shownHost}:${port}\n`);
  process.stderr.write("atlas-serve: press Ctrl-C to stop\n");
}

main().catch((err) => fail(messageOf(err)));
