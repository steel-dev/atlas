import type { LanguageModel } from "./model.js";
import type { BrowserProvider } from "./steel.js";
import type { SearchProvider } from "./search-provider.js";
import {
  startResearchStream,
  type QueryOptions,
  type ResearchResult,
  type ResearchStream,
  type RunInput,
  type RunOptions,
} from "./research.js";
import type { CompiledUserTool, ResearchTool } from "./research-tool.js";
import { compileUserTools } from "./tool-registry.js";

export interface ResearcherConfig {
  model: Exclude<LanguageModel, string>;
  summaryModel?: Exclude<LanguageModel, string>;
  browser?: BrowserProvider;
  search?: SearchProvider;
  instructions?: string;
  tools?: Record<string, ResearchTool>;
  defaults?: RunOptions;
}

/**
 * A configured research client. Binds the model, browser, search, instructions,
 * and tools once, then runs many queries against that configuration. Reserved
 * tool names are validated at construction; resources for a run are created per
 * call, so concurrent runs stay isolated.
 */
export class Researcher {
  readonly #config: ResearcherConfig;
  readonly #userTools?: ReadonlyMap<string, CompiledUserTool>;
  #closed = false;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(config: ResearcherConfig) {
    this.#config = config;
    this.#userTools =
      config.tools && Object.keys(config.tools).length > 0
        ? compileUserTools(config.tools)
        : undefined;
  }

  research(query: string, opts?: RunOptions): Promise<ResearchResult>;
  research(opts: QueryOptions): Promise<ResearchResult>;
  research(
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): Promise<ResearchResult> {
    return this.#start(queryOrOpts, maybeOpts).result;
  }

  stream(query: string, opts?: RunOptions): ResearchStream;
  stream(opts: QueryOptions): ResearchStream;
  stream(
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): ResearchStream {
    return this.#start(queryOrOpts, maybeOpts);
  }

  /** Marks the researcher closed and waits for in-flight runs to settle. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#inflight]);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #start(
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): ResearchStream {
    if (this.#closed) throw new Error("Researcher is closed");
    const handle = startResearchStream(this.#buildInput(queryOrOpts, maybeOpts));
    const tracked = handle.result.then(
      () => undefined,
      () => undefined,
    );
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
    return handle;
  }

  #buildInput(
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): RunInput {
    const isPositional = typeof queryOrOpts === "string";
    const query = isPositional ? queryOrOpts : queryOrOpts.query;
    const overrides: RunOptions = isPositional
      ? (maybeOpts ?? {})
      : stripQuery(queryOrOpts);
    const config = this.#config;
    return {
      query,
      model: config.model,
      ...(config.summaryModel ? { summaryModel: config.summaryModel } : {}),
      ...(config.browser ? { browser: config.browser } : {}),
      ...(config.search ? { search: config.search } : {}),
      ...config.defaults,
      ...overrides,
      ...(config.instructions ? { instructions: config.instructions } : {}),
      ...(this.#userTools ? { userTools: this.#userTools } : {}),
    };
  }
}

function stripQuery(opts: QueryOptions): RunOptions {
  const { query: _query, ...rest } = opts;
  return rest;
}
