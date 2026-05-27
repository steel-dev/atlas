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
  score: number;
  engineOrder: number;
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
          score,
          engineOrder: search.engineOrder,
        });
        continue;
      }

      existing.score += score;
      if (!existing.engines.includes(search.engine)) {
        existing.engines.push(search.engine);
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

export async function execSearch(
  args: SearchToolInput,
  ctx: ResearchLoopContext,
  searchIndex: number,
): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: search requires a non-empty `query`.";

  const rawLimit = args.limit ?? ctx.defaultSearchLimit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 20);

  ctx.emit({
    type: "searching",
    index: searchIndex,
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
      engine,
      engineOrder: engineOutcome.engineOrder,
      results,
    });
  }

  const results = mergeSearchResults(successfulSearches, limit);
  if (results.length > 0) {
    const successfulEngines = successfulSearches.map((search) => search.engine);
    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: results.length,
    });
    return JSON.stringify(
      {
        query,
        engines: successfulEngines,
        searched_engines: engines,
        results: compactSearchResults(results),
        warnings: failures.length > 0 ? failures : undefined,
      },
      null,
      2,
    );
  }

  const error = failures.join("; ") || "all engines failed";
  ctx.emit({
    type: "search_results",
    index: searchIndex,
    count: 0,
  });
  if (sawEmptyResults) {
    return JSON.stringify(
      {
        query,
        results: [],
        warnings: failures.length > 0 ? failures : undefined,
      },
      null,
      2,
    );
  }
  ctx.emit({
    type: "search_failed",
    index: searchIndex,
    error,
  });
  return `Search failed: ${error}`;
}
