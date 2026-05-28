import {
  ENGINES,
  webSearch,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";
import { errorMessage } from "./errors.js";
import type { ResearchLoopContext } from "./runtime.js";
import { runSteelRequest } from "./steel-runtime.js";
import { normalizeUrlForSource } from "./url.js";

const SEARCH_SNIPPET_CHARS = 500;
const RRF_K = 60;

export interface SearchToolInput {
  query?: string;
  queries?: string[];
  limit?: number;
}

const normalizeFetchUrl = normalizeUrlForSource;

function searchCacheKey(opts: {
  query: string;
  limit: number;
  engine: Engine;
  useProxy: boolean;
}): string {
  return [
    "web",
    opts.engine,
    opts.useProxy ? "proxy" : "direct",
    opts.limit,
    opts.query,
  ].join("\0");
}

export function searchEnginesInFallbackOrder(defaultEngine: Engine): Engine[] {
  return [
    defaultEngine,
    ...ENGINES.filter((engine) => engine !== defaultEngine),
  ];
}

async function searchWithCache(
  ctx: ResearchLoopContext,
  opts: { query: string; limit: number; engine: Engine },
): Promise<WebSearchOutcome> {
  const cacheKey = searchCacheKey({
    query: opts.query,
    limit: opts.limit,
    engine: opts.engine,
    useProxy: ctx.useProxy,
  });
  let outcomePromise = ctx.caches.serp.get(cacheKey);
  if (!outcomePromise) {
    outcomePromise = runSteelRequest(ctx, () =>
      webSearch({
        steel: ctx.steel,
        query: opts.query,
        engine: opts.engine,
        useProxy: ctx.useProxy,
        limit: opts.limit,
        signal: ctx.signal,
      }),
    );
    ctx.caches.serp.set(cacheKey, outcomePromise);
  }

  try {
    return await outcomePromise;
  } catch (err) {
    ctx.caches.serp.delete(cacheKey);
    throw err;
  }
}

function compactSearchResults(
  results: MergedSearchResult[],
): Array<{
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  engine: Engine;
  engine_rank: number;
  engines: Engine[];
  queries?: string[];
}> {
  return results.map((result, index) => ({
    rank: index + 1,
    title: result.title,
    url: result.url,
    ...(result.snippet
      ? { snippet: result.snippet.slice(0, SEARCH_SNIPPET_CHARS) }
      : {}),
    engine: result.engine,
    engine_rank: result.engineRank,
    engines: result.engines,
    ...(result.queries.length > 1 ? { queries: result.queries } : {}),
  }));
}

function dedupeSearchResults(
  results: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeFetchUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...result,
      position: deduped.length + 1,
    });
    if (deduped.length >= limit) break;
  }
  return deduped;
}

interface EngineSearchResults {
  query: string;
  engine: Engine;
  results: SearchResult[];
  engineOrder: number;
}

interface MergedSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: Engine;
  engineRank: number;
  engines: Engine[];
  queries: string[];
  score: number;
  engineOrder: number;
}

interface SearchCollection {
  query: string;
  engines: Engine[];
  searchedEngines: Engine[];
  successfulSearches: EngineSearchResults[];
  warnings: string[];
  sawEmptyResults: boolean;
}

function mergeSearchResults(
  successfulSearches: EngineSearchResults[],
  limit: number,
): MergedSearchResult[] {
  const byUrl = new Map<string, MergedSearchResult>();

  for (const search of successfulSearches) {
    const results = dedupeSearchResults(search.results, limit);
    for (const result of results) {
      const key = normalizeFetchUrl(result.url);
      const score = 1 / (RRF_K + result.position);
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, {
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          engine: search.engine,
          engineRank: result.position,
          engines: [search.engine],
          queries: [search.query],
          score,
          engineOrder: search.engineOrder,
        });
        continue;
      }

      existing.score += score;
      if (!existing.engines.includes(search.engine)) {
        existing.engines.push(search.engine);
      }
      if (!existing.queries.includes(search.query)) {
        existing.queries.push(search.query);
      }
      const isBetterDisplayResult =
        result.position < existing.engineRank ||
        (result.position === existing.engineRank &&
          search.engineOrder < existing.engineOrder);
      if (isBetterDisplayResult) {
        existing.title = result.title;
        existing.url = result.url;
        existing.snippet = result.snippet;
        existing.engine = search.engine;
        existing.engineRank = result.position;
        existing.engineOrder = search.engineOrder;
      }
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.engineRank !== b.engineRank) return a.engineRank - b.engineRank;
      return a.engineOrder - b.engineOrder;
    })
    .slice(0, limit);
}

export function searchQueryCount(args: SearchToolInput): number {
  return readSearchQueries(args).length;
}

function readSearchQueries(args: SearchToolInput): string[] {
  const rawQueries = Array.isArray(args.queries)
    ? args.queries
    : typeof args.queries === "string"
      ? parseStringifiedQueries(args.queries)
    : args.query !== undefined
      ? parseStringifiedQueries(String(args.query))
      : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of rawQueries) {
    const query = String(raw ?? "").trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
    if (queries.length >= 6) break;
  }
  return queries;
}

function parseStringifiedQueries(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => (typeof entry === "string" ? entry : ""))
          .filter(Boolean);
      }
    } catch {
      // Fall through to the single-query form.
    }
  }
  return [raw];
}

async function collectSearchResults(opts: {
  query: string;
  limit: number;
  index: number;
  ctx: ResearchLoopContext;
}): Promise<SearchCollection> {
  const { query, limit, index, ctx } = opts;
  ctx.emit({
    type: "searching",
    index,
    query,
  });

  const failures: string[] = [];
  let sawEmptyResults = false;
  const engines = searchEnginesInFallbackOrder(ctx.defaultEngine);
  const successfulSearches: EngineSearchResults[] = [];

  const engineOutcomes = await Promise.all(
    engines.map(async (engine, engineOrder) => {
      try {
        return {
          engine,
          engineOrder,
          outcome: await searchWithCache(ctx, { query, limit, engine }),
        };
      } catch (err) {
        return {
          engine,
          engineOrder,
          error: errorMessage(err),
        };
      }
    }),
  );

  for (const engineOutcome of engineOutcomes) {
    const { engine } = engineOutcome;
    let outcome: WebSearchOutcome;
    if ("error" in engineOutcome) {
      failures.push(`${engine}: ${engineOutcome.error}`);
      continue;
    }
    outcome = engineOutcome.outcome;

    if (!outcome.ok) {
      failures.push(`${engine}: ${outcome.error.message}`);
      continue;
    }

    const results = dedupeSearchResults(outcome.results, limit);
    if (results.length === 0) {
      sawEmptyResults = true;
      failures.push(`${engine}: no results`);
      continue;
    }

    successfulSearches.push({
      query,
      engine,
      engineOrder: engineOutcome.engineOrder,
      results,
    });
  }

  const results = mergeSearchResults(successfulSearches, limit);
  ctx.emit({
    type: "search_results",
    index,
    count: results.length,
  });
  return {
    query,
    engines: successfulSearches.map((search) => search.engine),
    searchedEngines: engines,
    successfulSearches,
    warnings: failures,
    sawEmptyResults,
  };
}

export async function execSearch(
  args: SearchToolInput,
  ctx: ResearchLoopContext,
  searchIndex: number,
): Promise<string> {
  const queries = readSearchQueries(args);
  if (queries.length === 0) return "Error: search requires non-empty `queries`.";

  const rawLimit = args.limit ?? ctx.defaultSearchLimit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 20);
  const collections = await Promise.all(
    queries.map((query, offset) =>
      collectSearchResults({
        query,
        limit,
        index: searchIndex + offset,
        ctx,
      }),
    ),
  );
  const successfulSearches = collections.flatMap(
    (collection) => collection.successfulSearches,
  );
  const results = mergeSearchResults(successfulSearches, limit);
  if (results.length > 0) {
    const successfulEngines = unique(
      successfulSearches.map((search) => search.engine),
    );
    const searchedEngines = unique(
      collections.flatMap((collection) => collection.searchedEngines),
    );
    const warnings = formatWarnings(collections, queries.length > 1);
    return JSON.stringify(
      {
        ...(queries.length === 1 ? { query: queries[0] } : { queries }),
        engines: successfulEngines,
        searched_engines: searchedEngines,
        results: compactSearchResults(results),
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      null,
      2,
    );
  }

  const warnings = formatWarnings(collections, queries.length > 1);
  const sawEmptyResults = collections.some((collection) => collection.sawEmptyResults);
  if (sawEmptyResults) {
    return JSON.stringify(
      {
        ...(queries.length === 1 ? { query: queries[0] } : { queries }),
        results: [],
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      null,
      2,
    );
  }
  const error = warnings.join("; ") || "all engines failed";
  ctx.emit({
    type: "search_failed",
    index: searchIndex,
    error,
  });
  return `Search failed: ${error}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function formatWarnings(
  collections: SearchCollection[],
  includeQuery: boolean,
): string[] {
  return collections.flatMap((collection) =>
    collection.warnings.map((warning) =>
      includeQuery ? `${collection.query}: ${warning}` : warning,
    ),
  );
}
