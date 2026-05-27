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
  results: SearchResult[],
  engine: Engine,
): Array<{
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  engine: Engine;
}> {
  return results.map((result) => ({
    rank: result.position,
    title: result.title,
    url: result.url,
    ...(result.snippet
      ? { snippet: result.snippet.slice(0, SEARCH_SNIPPET_CHARS) }
      : {}),
    engine,
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

  for (const engine of engines) {
    let outcome: WebSearchOutcome;
    try {
      outcome = await searchWithCache(ctx, { query, limit, engine });
    } catch (err) {
      failures.push(`${engine}: ${errorMessage(err)}`);
      continue;
    }

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

    ctx.emit({
      type: "search_results",
      index: searchIndex,
      count: results.length,
    });
    return JSON.stringify(
      {
        query,
        engine,
        results: compactSearchResults(results, engine),
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
