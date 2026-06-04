import type { FlexibleSchema, InferSchema } from "ai";
import type { LanguageModel } from "./model.js";
import type { BrowserProvider } from "./steel.js";
import type { SearchProvider } from "./search-provider.js";
import type { ResearchTool } from "./custom-tools.js";
import {
  startResearchStream,
  type QueryOptions,
  type ResearchResult,
  type ResearchStream,
  type RunInput,
  type RunOptions,
  type StructuredResearchResult,
  type StructuredResearchStream,
} from "./research.js";

export interface AtlasConfig {
  model: Exclude<LanguageModel, string>;
  leafModel?: Exclude<LanguageModel, string>;
  browser?: BrowserProvider;
  search?: SearchProvider;
  instructions?: string;
  tools?: Record<string, ResearchTool>;
  defaults?: RunOptions;
}

/**
 * A configured research client. Binds the model, browser, search, and
 * instructions once, then runs many queries against that configuration.
 * Resources for a run are created per call, so concurrent runs stay isolated.
 */
export class Atlas {
  readonly #config: AtlasConfig;
  #closed = false;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(config: AtlasConfig) {
    this.#config = config;
  }

  research(query: string, opts?: RunOptions): Promise<ResearchResult>;
  research<SCHEMA extends FlexibleSchema>(
    opts: QueryOptions & { outputSchema: SCHEMA },
  ): Promise<StructuredResearchResult<InferSchema<SCHEMA>>>;
  research(opts: QueryOptions): Promise<ResearchResult>;
  research(
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): Promise<ResearchResult> {
    return this.#start(queryOrOpts, maybeOpts).result;
  }

  stream(query: string, opts?: RunOptions): ResearchStream;
  stream<SCHEMA extends FlexibleSchema>(
    opts: QueryOptions & { outputSchema: SCHEMA },
  ): StructuredResearchStream<InferSchema<SCHEMA>>;
  stream(opts: QueryOptions): ResearchStream;
  stream(
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): ResearchStream {
    return this.#start(queryOrOpts, maybeOpts);
  }

  /** Marks the client closed and waits for in-flight runs to settle. */
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
    if (this.#closed) throw new Error("Atlas is closed");
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
      ...(config.leafModel ? { leafModel: config.leafModel } : {}),
      ...(config.browser ? { browser: config.browser } : {}),
      ...(config.search ? { search: config.search } : {}),
      ...(config.tools ? { tools: config.tools } : {}),
      ...config.defaults,
      ...overrides,
      ...(config.instructions ? { instructions: config.instructions } : {}),
    };
  }
}

function stripQuery(opts: QueryOptions): RunOptions {
  const { query: _query, ...rest } = opts;
  return rest;
}
