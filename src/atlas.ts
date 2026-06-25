import type { FlexibleSchema } from "ai";
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
import { extractStructured, type StructuredResult } from "./structured.js";
import { ConfigError } from "./errors.js";

export class Atlas {
  readonly #config: AtlasConfig;
  #closed = false;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(config: AtlasConfig) {
    this.#config = config;
  }

  research(
    question: string,
    options?: ResearchOptions,
  ): Promise<ResearchResult>;
  research<T>(
    question: string,
    options: ResearchOptions & { schema: FlexibleSchema<T> },
  ): Promise<StructuredResult<T>>;
  async research<T>(
    question: string,
    options: ResearchOptions & { schema?: FlexibleSchema<T> } = {},
  ): Promise<ResearchResult | StructuredResult<T>> {
    const { schema, ...rest } = options;
    const result = await this.#researchReport(question, rest);
    if (!schema) return result;
    const object = await extractStructured<T>(this.#config, rest, result, schema);
    return { ...result, object };
  }

  #researchReport(
    question: string,
    options: ResearchOptions,
  ): Promise<ResearchResult> {
    return this.#startRun(question, options).result();
  }

  start(question: string, options: ResearchOptions = {}): ResearchRun {
    if (this.#closed)
      throw new ConfigError("Atlas is closed; create a new instance");
    return this.#startRun(question, options);
  }

  #startRun(question: string, options: ResearchOptions): ResearchRun {
    const run = startRun({ config: this.#config, question, options });
    this.#track(run);
    return run;
  }

  asResearcher(describe: string): Researcher {
    return {
      describe,
      research: async (query, ctx) => {
        const result = await this
          .#startRun(query, {
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
    if (this.#closed) throw new ConfigError("Atlas is closed; create a new instance");
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
