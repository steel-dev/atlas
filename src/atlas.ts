import type { FlexibleSchema, InferSchema } from "ai";
import type { AtlasConfig, ResearchOptions } from "./config.js";
import {
  resumeRun,
  startRun,
  type ResearchResult,
  type ResearchRun,
  type ResumeOptions,
} from "./run.js";

export type { AtlasConfig, ResearchOptions } from "./config.js";

export interface StructuredResearchResult<T> extends ResearchResult {
  structured: T;
}

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
  research<SCHEMA extends FlexibleSchema>(
    question: string,
    options: ResearchOptions & {
      output: { kind: "structured"; schema: SCHEMA };
    },
  ): Promise<StructuredResearchResult<InferSchema<SCHEMA>>>;
  research(
    question: string,
    options: ResearchOptions = {},
  ): Promise<ResearchResult> {
    return this.start(question, options).result();
  }

  start(question: string, options: ResearchOptions = {}): ResearchRun {
    if (this.#closed) throw new Error("Atlas is closed");
    const run = startRun({ config: this.#config, question, options });
    this.#track(run);
    return run;
  }

  static resume(
    runId: string,
    config: AtlasConfig,
    options?: ResumeOptions,
  ): Promise<ResearchRun> {
    return resumeRun(runId, config, options);
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
