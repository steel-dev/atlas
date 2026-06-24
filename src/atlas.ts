import type { AtlasConfig, ResearchOptions } from "./config.js";
import {
  resumeRun,
  startRun,
  type ResearchResult,
  type ResearchRun,
  type ResumeOptions,
} from "./run.js";

export type { AtlasConfig, ResearchOptions } from "./config.js";
import type { Researcher } from "./researcher.js";
import { runOrchestrated } from "./orchestrate.js";

const DEFAULT_ATLAS_DESCRIBE =
  "Atlas's own deep-research spine: plans, searches, fetches, and synthesizes a grounded, citation-backed report. Strong on academic, finance, and multi-source synthesis. Default for any sub-task without a more specialized fit.";

export class Atlas {
  readonly #config: AtlasConfig;
  #closed = false;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(config: AtlasConfig) {
    this.#config = config;
  }

  research(
    question: string,
    options: ResearchOptions = {},
  ): Promise<ResearchResult> {
    const researchers = this.#config.researchers;
    if (researchers && Object.keys(researchers).length > 0) {
      return runOrchestrated(this.#config, question, options, {
        atlas: this.asResearcher(DEFAULT_ATLAS_DESCRIBE),
        ...researchers,
      });
    }
    return this.start(question, options).result();
  }

  start(question: string, options: ResearchOptions = {}): ResearchRun {
    if (this.#closed) throw new Error("Atlas is closed");
    const run = startRun({ config: this.#config, question, options });
    this.#track(run);
    return run;
  }

  asResearcher(describe: string): Researcher {
    return {
      describe,
      research: async (query, ctx) => {
        const result = await this
          .start(query, {
            budget: { maxUSD: ctx.budget.maxUSD },
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
          .result();
        return {
          report: result.report,
          sources: result.sources.map((s) => ({ url: s.url, title: s.title })),
          cost: result.stats.costUSD,
          confidence: 1,
        };
      },
    };
  }

  async resume(runId: string, options?: ResumeOptions): Promise<ResearchRun> {
    if (this.#closed) throw new Error("Atlas is closed");
    const run = await resumeRun(runId, this.#config, options);
    this.#track(run);
    return run;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#inflight]);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #track(run: ResearchRun): void {
    const tracked = run.result().then(
      () => undefined,
      () => undefined,
    );
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
  }
}
