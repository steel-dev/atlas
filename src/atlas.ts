import type { FlexibleSchema } from "ai";
import type { AtlasConfig, ResearchOptions } from "./config.js";
import {
  type ResearchResult,
  type ResearchRun,
  type ResumeOptions,
  resumeRun,
  startRun,
} from "./run.js";

export type { AtlasConfig, ResearchOptions } from "./config.js";

import { AtlasError } from "./errors.js";
import type { Researcher } from "./researcher.js";
import type { StructuredResult } from "./structured.js";

export class Atlas {
  readonly #config: AtlasConfig;
  #closed = false;
  readonly #runs = new Set<ResearchRun>();

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
    if (this.#closed)
      throw new AtlasError("Atlas is closed; create a new instance", "config");
    const { schema, ...rest } = options;
    const result = await this.#startRun(
      question,
      rest,
      schema as FlexibleSchema<unknown> | undefined,
    ).result();
    return schema ? (result as StructuredResult<T>) : result;
  }

  start(question: string, options: ResearchOptions = {}): ResearchRun {
    if (this.#closed)
      throw new AtlasError("Atlas is closed; create a new instance", "config");
    return this.#startRun(question, options);
  }

  #startRun(
    question: string,
    options: ResearchOptions,
    schema?: FlexibleSchema<unknown> | undefined,
  ): ResearchRun {
    const run = startRun({
      config: this.#config,
      question,
      options,
      ...(schema ? { schema } : {}),
    });
    this.#track(run);
    return run;
  }

  asResearcher(description: string): Researcher {
    return {
      description,
      research: async (query, ctx) => {
        const result = await this.#startRun(query, {
          budget: { maxUSD: ctx.budget.maxUSD },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }).result();
        return {
          report: result.report,
          sources: result.sources.map((s) => ({ url: s.url, title: s.title })),
          cost: result.stats.costUSD,
        };
      },
    };
  }

  async resume(runId: string, options?: ResumeOptions): Promise<ResearchRun> {
    if (this.#closed)
      throw new AtlasError("Atlas is closed; create a new instance", "config");
    const run = await resumeRun(runId, this.#config, options);
    this.#track(run);
    return run;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#runs].map((run) => run.abort()));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #track(run: ResearchRun): void {
    this.#runs.add(run);
    void run
      .result()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => this.#runs.delete(run));
  }
}
