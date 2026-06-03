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

export interface Researcher {
  research(query: string, opts?: RunOptions): Promise<ResearchResult>;
  research(opts: QueryOptions): Promise<ResearchResult>;
  stream(query: string, opts?: RunOptions): ResearchStream;
  stream(opts: QueryOptions): ResearchStream;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function createResearcher(config: ResearcherConfig): Researcher {
  const userTools: ReadonlyMap<string, CompiledUserTool> | undefined =
    config.tools && Object.keys(config.tools).length > 0
      ? compileUserTools(config.tools)
      : undefined;
  let closed = false;
  const inflight = new Set<Promise<unknown>>();

  const buildInput = (
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): RunInput => {
    const isPositional = typeof queryOrOpts === "string";
    const query = isPositional ? queryOrOpts : queryOrOpts.query;
    const overrides: RunOptions = isPositional
      ? (maybeOpts ?? {})
      : stripQuery(queryOrOpts);
    return {
      query,
      model: config.model,
      ...(config.summaryModel ? { summaryModel: config.summaryModel } : {}),
      ...(config.browser ? { browser: config.browser } : {}),
      ...(config.search ? { search: config.search } : {}),
      ...config.defaults,
      ...overrides,
      ...(config.instructions ? { instructions: config.instructions } : {}),
      ...(userTools ? { userTools } : {}),
    };
  };

  const stream = (
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): ResearchStream => {
    if (closed) throw new Error("createResearcher: researcher is closed");
    const handle = startResearchStream(buildInput(queryOrOpts, maybeOpts));
    const tracked = handle.result.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
    return handle;
  };

  const research = (
    queryOrOpts: string | QueryOptions,
    maybeOpts?: RunOptions,
  ): Promise<ResearchResult> => stream(queryOrOpts, maybeOpts).result;

  const close = async (): Promise<void> => {
    closed = true;
    await Promise.allSettled([...inflight]);
  };

  return {
    research,
    stream,
    close,
    [Symbol.asyncDispose]: close,
  };
}

function stripQuery(opts: QueryOptions): RunOptions {
  const { query: _query, ...rest } = opts;
  return rest;
}
