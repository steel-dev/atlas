import {
  dedupeSearchResults,
  searchEnginesForFusion,
  type SearchResult,
} from "./search.js";
import {
  createScrapingSearchProvider,
  type SearchProvider,
  type SearchQueryOutcome,
  type SearchSourceResults,
} from "./search-provider.js";
import { errorMessage } from "./errors.js";
import type { ResearchCtx } from "./runtime.js";
import { normalizeUrlForSource } from "./url.js";

const SEARCH_SNIPPET_CHARS = 500;
const SEARCH_TRACE_RESULTS = 5;
const SEARCH_TRACE_SNIPPET_CHARS = 200;
const RRF_K = 60;

export interface SearchToolInput {
  query?: string;
  queries?: string[];
  limit?: number;
}

export { searchEnginesForFusion };

function compactSearchResults(results: MergedSearchResult[]): Array<{
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  engine: string;
  engine_rank: number;
  engines: string[];
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

interface SourceResultList {
  query: string;
  source: string;
  order: number;
  results: SearchResult[];
}

export interface MergedSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  engineRank: number;
  engines: string[];
  queries: string[];
  score: number;
  engineOrder: number;
}

interface SearchCollection {
  query: string;
  sources: SearchSourceResults[];
  searchedSources: string[];
  warnings: string[];
  sawEmptyResults: boolean;
}

function mergeSearchResults(
  lists: SourceResultList[],
  limit: number,
): MergedSearchResult[] {
  const byUrl = new Map<string, MergedSearchResult>();

  for (const list of lists) {
    const results = dedupeSearchResults(list.results, limit);
    for (const result of results) {
      const key = normalizeUrlForSource(result.url);
      const score = 1 / (RRF_K + result.position);
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, {
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          engine: list.source,
          engineRank: result.position,
          engines: [list.source],
          queries: [list.query],
          score,
          engineOrder: list.order,
        });
        continue;
      }

      existing.score += score;
      if (!existing.engines.includes(list.source)) {
        existing.engines.push(list.source);
      }
      if (!existing.queries.includes(list.query)) {
        existing.queries.push(list.query);
      }
      const isBetterDisplayResult =
        result.position < existing.engineRank ||
        (result.position === existing.engineRank &&
          list.order < existing.engineOrder);
      if (isBetterDisplayResult) {
        existing.title = result.title;
        existing.url = result.url;
        existing.snippet = result.snippet;
        existing.engine = list.source;
        existing.engineRank = result.position;
        existing.engineOrder = list.order;
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
      ? (parseStringifiedQueries(args.queries) ?? [])
      : args.query !== undefined
        ? [args.query]
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

function parseStringifiedQueries(raw: string): string[] | null {
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
      return null;
    }
  }
  return null;
}

async function collectSearchResults(opts: {
  query: string;
  limit: number;
  index: number;
  ctx: ResearchCtx;
  provider: SearchProvider;
}): Promise<SearchCollection> {
  const { query, limit, index, ctx, provider } = opts;
  ctx.scope.emit({
    type: "searching",
    index,
    query,
  });

  let outcome: SearchQueryOutcome;
  try {
    outcome = await provider.searchQuery({
      query,
      limit,
      signal: ctx.deps.signal,
    });
  } catch (err) {
    ctx.scope.emit({ type: "search_results", index, count: 0 });
    return {
      query,
      sources: [],
      searchedSources: [provider.name],
      warnings: [`${provider.name}: ${errorMessage(err)}`],
      sawEmptyResults: false,
    };
  }

  const distinctUrls = new Set<string>();
  const tracedResults: Array<{
    url: string;
    domain: string;
    title?: string;
    snippet?: string;
  }> = [];
  for (const source of outcome.sources) {
    for (const result of source.results) {
      const key = normalizeUrlForSource(result.url);
      if (distinctUrls.has(key)) continue;
      distinctUrls.add(key);
      if (tracedResults.length < SEARCH_TRACE_RESULTS) {
        tracedResults.push({
          url: result.url,
          domain: result.domain,
          ...(result.title ? { title: result.title } : {}),
          ...(result.snippet
            ? { snippet: result.snippet.slice(0, SEARCH_TRACE_SNIPPET_CHARS) }
            : {}),
        });
      }
    }
  }
  ctx.scope.emit({
    type: "search_results",
    index,
    count: Math.min(distinctUrls.size, limit),
    ...(tracedResults.length > 0 ? { results: tracedResults } : {}),
  });
  return {
    query,
    sources: outcome.sources,
    searchedSources: outcome.attempted,
    warnings: outcome.warnings,
    sawEmptyResults: outcome.sawEmptyResults,
  };
}

export interface SearchRunOutcome {
  providerName: string;
  results: MergedSearchResult[];
  successfulEngines: string[];
  searchedEngines: string[];
  warnings: string[];
  sawEmptyResults: boolean;
}

export async function runSearchQueries(
  ctx: ResearchCtx,
  queries: string[],
  opts: { limit: number; searchIndexStart: number },
): Promise<SearchRunOutcome> {
  const provider = ctx.deps.searchProvider ?? createScrapingSearchProvider(ctx);
  const collections = await Promise.all(
    queries.map((query, offset) =>
      collectSearchResults({
        query,
        limit: opts.limit,
        index: opts.searchIndexStart + offset,
        ctx,
        provider,
      }),
    ),
  );
  const sourceLists: SourceResultList[] = collections.flatMap((collection) =>
    collection.sources.map((source) => ({
      query: collection.query,
      source: source.source,
      order: source.order,
      results: source.results,
    })),
  );
  return {
    providerName: provider.name,
    results: mergeSearchResults(sourceLists, opts.limit),
    successfulEngines: unique(sourceLists.map((source) => source.source)),
    searchedEngines: unique(
      collections.flatMap((collection) => collection.searchedSources),
    ),
    warnings: formatWarnings(collections, queries.length > 1),
    sawEmptyResults: collections.some(
      (collection) => collection.sawEmptyResults,
    ),
  };
}

export async function execSearch(
  args: SearchToolInput,
  ctx: ResearchCtx,
  searchIndex: number,
): Promise<string> {
  const queries = readSearchQueries(args);
  if (queries.length === 0) {
    return "Error: search requires `queries` to be an array of non-empty strings.";
  }

  const rawLimit = args.limit ?? ctx.config.defaultSearchLimit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 20);
  const outcome = await runSearchQueries(ctx, queries, {
    limit,
    searchIndexStart: searchIndex,
  });
  if (outcome.results.length > 0) {
    return JSON.stringify(
      {
        ...(queries.length === 1 ? { query: queries[0] } : { queries }),
        provider: outcome.providerName,
        engines: outcome.successfulEngines,
        searched_engines: outcome.searchedEngines,
        results: compactSearchResults(outcome.results),
        warnings: outcome.warnings.length > 0 ? outcome.warnings : undefined,
      },
      null,
      2,
    );
  }

  if (outcome.sawEmptyResults) {
    return JSON.stringify(
      {
        ...(queries.length === 1 ? { query: queries[0] } : { queries }),
        provider: outcome.providerName,
        results: [],
        warnings: outcome.warnings.length > 0 ? outcome.warnings : undefined,
      },
      null,
      2,
    );
  }
  const error = outcome.warnings.join("; ") || "all sources failed";
  ctx.scope.emit({
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
