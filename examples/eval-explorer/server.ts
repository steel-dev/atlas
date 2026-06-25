import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import * as ts from "typescript";
import { ensureCatalog } from "./catalog.js";
import { captureCommit } from "./git.js";
import type { DracoRunHost, WireEvent } from "./runner.js";
import type { Store } from "./store.js";

export interface ExploreServerConfig {
  store: Store;
  runHost: DracoRunHost;
  casesUrl: string;
  port: number;
  hostname: string;
  profile: Record<string, unknown>;
}

function page(): string {
  return readFileSync(new URL("./explore.page.html", import.meta.url), "utf8");
}

function clientJs(): string {
  const src = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function jsonOrNull(value: unknown): unknown {
  return typeof value === "string" && value.length > 0
    ? JSON.parse(value)
    : null;
}

function buildCaseResponse(
  store: Store,
  commit: string,
  caseId: string,
): Record<string, unknown> | undefined {
  const detail = store.detail(commit, caseId);
  if (detail) {
    return {
      caseId,
      domain: (detail.case_domain as string) ?? (detail.domain as string),
      problem: detail.case_problem as string,
      sections: jsonOrNull(detail.sections_json) ?? [],
      criteria: jsonOrNull(detail.criteria_json) ?? [],
      run: {
        status: detail.status,
        score: jsonOrNull(detail.score_json),
        report: jsonOrNull(detail.report_json),
        markdown: (detail.markdown as string | null) ?? null,
        metrics: jsonOrNull(detail.metrics_json),
        diagnostics: jsonOrNull(detail.diagnostics_json),
        profile: {
          researchProvider: detail.research_provider,
          researchModel: detail.research_model,
          judgeProvider: detail.judge_provider,
          judgeModel: detail.judge_model,
          grader: detail.grader,
        },
        latencyMs: detail.latency_ms,
        createdAt: detail.created_at,
        dirty: Boolean(detail.dirty),
        finishReason: detail.finish_reason,
        error: detail.error,
        judgeErrors: detail.judge_errors,
      },
    };
  }
  const rubric = store.caseRubric(caseId);
  if (!rubric) return undefined;
  return {
    caseId,
    domain: rubric.domain as string,
    problem: rubric.problem as string,
    sections: jsonOrNull(rubric.sections_json) ?? [],
    criteria: jsonOrNull(rubric.criteria_json) ?? [],
  };
}

function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  config: ExploreServerConfig,
  id: string,
  fromParam: string | null,
): void {
  const entry = config.runHost.get(id);
  if (!entry) {
    sendJson(res, 404, { error: "run not found" });
    return;
  }
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
  const terminal =
    entry.phase === "done" ||
    entry.phase === "error" ||
    entry.phase === "stopped";
  if (terminal && entry.subs.size === 0) {
    res.end();
    return;
  }

  const fn = (event: WireEvent | null, seq: number) => {
    if (event) res.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    else res.end();
  };
  config.runHost.attach(entry, fn);
  res.on("close", () => config.runHost.detach(entry, fn));
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: ExploreServerConfig,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const { store, runHost } = config;

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(page());
    return;
  }

  if (method === "GET" && path === "/client.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(clientJs());
    return;
  }

  if (method === "GET" && path === "/api/catalog") {
    try {
      const count = await ensureCatalog(store, config.casesUrl);
      sendJson(res, 200, {
        revision: store.getMeta("catalog_revision") ?? null,
        count,
        cases: store.listCatalog(),
      });
    } catch (err) {
      if (store.caseCount() > 0) {
        sendJson(res, 200, {
          revision: store.getMeta("catalog_revision") ?? null,
          count: store.caseCount(),
          cases: store.listCatalog(),
          warning: `catalog refresh failed: ${messageOf(err)} (serving cache)`,
        });
      } else {
        sendJson(res, 503, { error: `catalog unavailable: ${messageOf(err)}` });
      }
    }
    return;
  }

  if (method === "POST" && path === "/api/catalog/refresh") {
    try {
      const count = await ensureCatalog(store, config.casesUrl, true);
      sendJson(res, 200, { count });
    } catch (err) {
      sendJson(res, 503, { error: messageOf(err) });
    }
    return;
  }

  if (method === "GET" && path === "/api/commits") {
    sendJson(res, 200, {
      current: captureCommit(),
      canRun: runHost.canRun,
      profile: config.profile,
      commits: store.commits(),
    });
    return;
  }

  if (method === "GET" && path === "/api/grid") {
    const commit = url.searchParams.get("commit") || captureCommit().sha;
    sendJson(res, 200, { commit, rows: store.grid(commit) });
    return;
  }

  const caseMatch = path.match(/^\/api\/case\/([^/]+)$/);
  if (method === "GET" && caseMatch) {
    const caseId = decodeURIComponent(caseMatch[1]);
    const commit = url.searchParams.get("commit") || captureCommit().sha;
    const body = buildCaseResponse(store, commit, caseId);
    if (!body) {
      sendJson(res, 404, { error: "case not found" });
      return;
    }
    sendJson(res, 200, { commit, ...body });
    return;
  }

  if (method === "GET" && path === "/api/runs") {
    sendJson(res, 200, { runs: runHost.list() });
    return;
  }

  if (method === "POST" && path === "/api/runs/run-unrun") {
    if (!runHost.canRun) {
      sendJson(res, 409, { error: "judge not configured" });
      return;
    }
    const commit = url.searchParams.get("commit") || captureCommit().sha;
    try {
      const runIds = runHost.enqueueUnrun(commit);
      sendJson(res, 201, { runIds, queued: runIds.length });
    } catch (err) {
      sendJson(res, 400, { error: messageOf(err) });
    }
    return;
  }

  const runMatch = path.match(
    /^\/api\/runs\/([^/]+)\/(run|stream|stop|abort)$/,
  );
  if (runMatch) {
    const target = decodeURIComponent(runMatch[1]);
    const action = runMatch[2];
    if (method === "POST" && action === "run") {
      if (!runHost.canRun) {
        sendJson(res, 409, { error: "judge not configured" });
        return;
      }
      try {
        const entry = runHost.enqueue(target);
        sendJson(res, 201, { runId: entry.id, phase: entry.phase });
      } catch (err) {
        sendJson(res, 400, { error: messageOf(err) });
      }
      return;
    }
    if (method === "GET" && action === "stream") {
      streamRun(req, res, config, target, url.searchParams.get("from"));
      return;
    }
    if (method === "POST" && action === "stop") {
      sendJson(res, 200, { stopped: runHost.stop(target) });
      return;
    }
    if (method === "POST" && action === "abort") {
      sendJson(res, 200, { aborted: runHost.abort(target) });
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

export async function serveExplore(config: ExploreServerConfig): Promise<void> {
  const server = createServer((req, res) => {
    void route(req, res, config).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end(messageOf(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => reject(err);
    server.once("error", onError);
    server.listen(config.port, config.hostname, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const shownHost =
    config.hostname === "0.0.0.0" || config.hostname === "::"
      ? "localhost"
      : config.hostname;
  process.stderr.write(
    `draco-explore: web UI on http://${shownHost}:${config.port}\n`,
  );
  if (!config.runHost.canRun) {
    process.stderr.write(
      "draco-explore: judge key missing — view/import only; runs disabled\n",
    );
  }
  process.stderr.write("draco-explore: press Ctrl-C to stop\n");
}
