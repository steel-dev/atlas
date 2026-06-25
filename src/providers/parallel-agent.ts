import { sleep } from "../async.js";
import { readEnv } from "../env.js";
import type { Researcher } from "../researcher.js";

export interface ParallelAgentOptions {
  apiKey?: string;
  baseUrl?: string;
  processor?: string;
  describe?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  costPerRunUSD?: number;
}

const PARALLEL_PRICE_PER_RUN: Record<string, number> = {
  lite: 0.005,
  base: 0.01,
  core: 0.025,
  core2x: 0.05,
  pro: 0.1,
  ultra: 0.3,
  ultra2x: 0.6,
  ultra4x: 1.2,
  ultra8x: 2.4,
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "cancelling",
  "error",
]);

const DEFAULT_DESCRIBE =
  "Parallel.ai task research: autonomous web research returning a citation-backed result. Strong on enrichment, structured/entity extraction, and broad gathering.";

interface ParallelResult {
  output?: {
    content?: unknown;
    basis?: Array<{ citations?: Array<{ url?: string; title?: string }> }>;
  };
}

export function parallelAgent(opts: ParallelAgentOptions = {}): Researcher {
  const apiKey =
    opts.apiKey ?? readEnv("ATLAS_PARALLEL_API_KEY", "PARALLEL_API_KEY");
  const base = (opts.baseUrl ?? "https://api.parallel.ai").replace(/\/+$/, "");
  return {
    describe: opts.describe ?? DEFAULT_DESCRIBE,
    async research(query, ctx) {
      if (!apiKey) {
        throw new Error(
          "parallel.agent: no API key (set ATLAS_PARALLEL_API_KEY / PARALLEL_API_KEY or pass { apiKey })",
        );
      }
      const headers = { "content-type": "application/json", "x-api-key": apiKey };
      const processor = opts.processor ?? "core";
      const created = await fetch(`${base}/v1/tasks/runs`, {
        method: "POST",
        signal: ctx.signal ?? null,
        headers,
        body: JSON.stringify({
          input: query,
          processor,
        }),
      });
      if (!created.ok) {
        throw new Error(`parallel.agent: create HTTP ${created.status}`);
      }
      const run = (await created.json()) as {
        run_id?: string;
        status?: string;
      };
      if (!run.run_id) {
        throw new Error("parallel.agent: no run_id in create response");
      }
      const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let status = run.status ?? "queued";
      while (!TERMINAL_STATUSES.has(status)) {
        if (Date.now() > deadline) {
          throw new Error("parallel.agent: timed out waiting for the task run");
        }
        await sleep(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, ctx.signal);
        const polled = await fetch(`${base}/v1/tasks/runs/${run.run_id}`, {
          signal: ctx.signal ?? null,
          headers,
        });
        if (!polled.ok) {
          throw new Error(`parallel.agent: poll HTTP ${polled.status}`);
        }
        status = ((await polled.json()) as { status?: string }).status ?? status;
      }
      if (status !== "completed") {
        throw new Error(`parallel.agent: task run ${status}`);
      }
      const resultResp = await fetch(
        `${base}/v1/tasks/runs/${run.run_id}/result`,
        { signal: ctx.signal ?? null, headers },
      );
      if (!resultResp.ok) {
        throw new Error(`parallel.agent: result HTTP ${resultResp.status}`);
      }
      const data = (await resultResp.json()) as ParallelResult;
      const content = data.output?.content;
      const report = (
        typeof content === "string" ? content : JSON.stringify(content ?? "")
      ).trim();
      const seen = new Set<string>();
      const sources: { url: string; title?: string }[] = [];
      for (const field of data.output?.basis ?? []) {
        for (const citation of field.citations ?? []) {
          if (citation.url && !seen.has(citation.url)) {
            seen.add(citation.url);
            sources.push({
              url: citation.url,
              ...(citation.title ? { title: citation.title } : {}),
            });
          }
        }
      }
      const cost = opts.costPerRunUSD ?? PARALLEL_PRICE_PER_RUN[processor];
      ctx.log(
        `parallel.agent: ${sources.length} sources` +
          (cost != null
            ? `, $${cost.toFixed(4)}`
            : " (cost unknown — set costPerRunUSD)"),
      );
      return { report, sources, ...(cost != null ? { cost } : {}) };
    },
  };
}
