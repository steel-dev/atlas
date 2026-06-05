import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { Atlas } from "./atlas.js";
import { resolveModelSpec } from "./config-resolution.js";
import { steel } from "./steel.js";
import { exa, brave, type SearchProvider } from "./search-provider.js";
import type {
  ModelProvider,
  ResearchEvent,
  ResearchResult,
  ResearchStream,
} from "./research.js";

export interface ServeOptions {
  port: number;
  host: string;
  provider?: ModelProvider;
  model?: string;
  leafModel?: string;
  searchProvider?: string;
  proxy?: boolean;
}

type WireEvent = ResearchEvent | { type: "error"; message: string };
type Subscriber = (event: WireEvent | null, seq: number) => void;

interface RunEntry {
  id: string;
  query: string;
  run: ResearchStream;
  log: WireEvent[];
  subs: Set<Subscriber>;
  done: boolean;
  startedAt: number;
  endedAt?: number;
  error?: string;
  result?: ResearchResult;
  sources: number;
  confirmed: number;
  angles: number;
  reaper?: ReturnType<typeof setTimeout>;
}

const RUN_OPTS = {
  exploreProviderOptions: { anthropic: { thinking: { type: "adaptive" } } },
  finalizeProviderOptions: {
    anthropic: { thinking: { type: "adaptive" }, effort: "high" },
    openai: { reasoningEffort: "high" },
  },
};

const ABANDON_MS = 90_000;
const MAX_RUNS = 50;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class RunHost {
  private readonly runs = new Map<string, RunEntry>();
  private counter = 0;

  constructor(private readonly atlas: Atlas) {}

  create(query: string): RunEntry {
    const id = "run_" + Date.now().toString(36) + (this.counter++).toString(36);
    const run = this.atlas.stream(query, RUN_OPTS);
    const entry: RunEntry = {
      id,
      query,
      run,
      log: [],
      subs: new Set(),
      done: false,
      startedAt: Date.now(),
      sources: 0,
      confirmed: 0,
      angles: 0,
    };
    this.runs.set(id, entry);
    this.evict();
    void this.drain(entry);
    this.armReaper(entry);
    return entry;
  }

  get(id: string): RunEntry | undefined {
    return this.runs.get(id);
  }

  attach(entry: RunEntry, fn: Subscriber): void {
    entry.subs.add(fn);
    if (entry.reaper) {
      clearTimeout(entry.reaper);
      entry.reaper = undefined;
    }
  }

  detach(entry: RunEntry, fn: Subscriber): void {
    entry.subs.delete(fn);
    if (entry.subs.size === 0 && !entry.done) this.armReaper(entry);
  }

  stop(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry || entry.done) return false;
    entry.run.stop();
    return true;
  }

  abort(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry || entry.done) return false;
    entry.run.abort();
    return true;
  }

  list(): Array<Record<string, unknown>> {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => ({
        id: e.id,
        query: e.query,
        status: this.status(e),
        startedAt: e.startedAt,
        endedAt: e.endedAt ?? null,
        sources: e.sources,
        confirmed: e.confirmed,
        angles: e.angles,
      }));
  }

  private status(entry: RunEntry): string {
    if (entry.error) return "error";
    if (!entry.done) return "running";
    return entry.result ? "done" : "stopped";
  }

  private armReaper(entry: RunEntry): void {
    if (entry.reaper) clearTimeout(entry.reaper);
    entry.reaper = setTimeout(() => {
      if (entry.subs.size === 0 && !entry.done) entry.run.abort();
    }, ABANDON_MS);
  }

  private async drain(entry: RunEntry): Promise<void> {
    const push = (event: WireEvent) => {
      entry.log.push(event);
      const seq = entry.log.length;
      for (const fn of entry.subs) fn(event, seq);
    };
    try {
      for await (const event of entry.run.fullStream) {
        if (event.type === "scope_completed") entry.angles = event.angles.length;
        else if (event.type === "source_fetched") entry.sources++;
        else if (event.type === "claim_verified" && event.status === "confirmed")
          entry.confirmed++;
        else if (event.type === "completed") entry.result = event.result;
        push(event);
      }
    } catch (err) {
      const event: WireEvent = { type: "error", message: messageOf(err) };
      entry.error = event.message;
      push(event);
    } finally {
      entry.done = true;
      entry.endedAt = Date.now();
      if (entry.reaper) {
        clearTimeout(entry.reaper);
        entry.reaper = undefined;
      }
      for (const fn of entry.subs) fn(null, entry.log.length);
    }
  }

  private evict(): void {
    if (this.runs.size <= MAX_RUNS) return;
    const oldestFirst = [...this.runs.values()].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    for (const entry of oldestFirst) {
      if (this.runs.size <= MAX_RUNS) break;
      if (entry.done) this.runs.delete(entry.id);
    }
  }
}

let cachedPage: string | undefined;

function page(): string {
  if (cachedPage === undefined) {
    cachedPage = readFileSync(
      new URL("./serve.page.html", import.meta.url),
      "utf8",
    );
  }
  return cachedPage;
}

function resolveSearch(raw: string | undefined): SearchProvider | undefined {
  const kind = (raw ?? "").trim().toLowerCase();
  if (!kind || kind === "web") return undefined;
  if (kind === "exa") return exa();
  if (kind === "brave") return brave();
  throw new Error(
    `--search-provider must be one of: web, exa, brave (got "${raw}")`,
  );
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
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  host: RunHost,
  entry: RunEntry,
  fromParam: string | null,
): void {
  const headerId = req.headers["last-event-id"];
  const fromRaw =
    fromParam ?? (typeof headerId === "string" ? headerId : null) ?? "0";
  let from = Number(fromRaw);
  if (!Number.isFinite(from) || from < 0) from = 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  for (let i = from; i < entry.log.length; i++) {
    res.write(`id: ${i + 1}\ndata: ${JSON.stringify(entry.log[i])}\n\n`);
  }
  if (entry.done) {
    res.end();
    return;
  }

  const fn: Subscriber = (event, seq) => {
    if (event) res.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    else res.end();
  };
  host.attach(entry, fn);
  res.on("close", () => host.detach(entry, fn));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  host: RunHost,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(page());
    return;
  }

  if (method === "GET" && path === "/api/runs") {
    sendJson(res, 200, { runs: host.list() });
    return;
  }

  if (method === "POST" && path === "/api/runs") {
    const body = await readBody(req).catch(() => "");
    let query = "";
    try {
      const parsed = JSON.parse(body || "{}") as { query?: unknown };
      if (typeof parsed.query === "string") query = parsed.query.trim();
    } catch {
      query = "";
    }
    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const entry = host.create(query);
    sendJson(res, 201, { runId: entry.id });
    return;
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/stream|\/stop|\/abort)?$/);
  if (runMatch) {
    const id = decodeURIComponent(runMatch[1]);
    const action = runMatch[2];
    const entry = host.get(id);
    if (!entry) {
      sendJson(res, 404, { error: "run not found" });
      return;
    }
    if (method === "GET" && action === "/stream") {
      streamRun(req, res, host, entry, url.searchParams.get("from"));
      return;
    }
    if (method === "POST" && action === "/stop") {
      sendJson(res, 200, { stopped: host.stop(id) });
      return;
    }
    if (method === "POST" && action === "/abort") {
      sendJson(res, 200, { aborted: host.abort(id) });
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

export async function serve(opts: ServeOptions): Promise<void> {
  const { model, leafModel } = await resolveModelSpec({
    provider: opts.provider,
    model: opts.model,
    leafModel: opts.leafModel,
  });
  const search = resolveSearch(opts.searchProvider);
  const atlas = new Atlas({
    model,
    ...(leafModel ? { leafModel } : {}),
    ...(search ? { search } : {}),
    ...(opts.proxy ? { browser: steel({ proxy: true }) } : {}),
  });
  const host = new RunHost(atlas);

  const server = createServer((req, res) => {
    void route(req, res, host).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(messageOf(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => reject(err);
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const shownHost =
    opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host;
  process.stderr.write(`atlas: web UI on http://${shownHost}:${opts.port}\n`);
  process.stderr.write("atlas: press Ctrl-C to stop\n");
}
