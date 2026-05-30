import {
  dedupeSearchResults,
  searchEnginesInFallbackOrder,
  type SearchResult,
} from "./search.js";
import {
  createScrapingSearchProvider,
  type SearchProvider,
  type SearchQueryOutcome,
  type SearchSourceResults,
} from "./search-provider.js";
import { errorMessage } from "./errors.js";
import type { ResearchLoopContext } from "./runtime.js";
import { normalizeUrlForSource } from "./url.js";

const SEARCH_SNIPPET_CHARS = 500;
const RRF_K = 60;

export interface SearchToolInput {
  query?: string;
  queries?: string[];
  limit?: number;
}

const normalizeFetchUrl = normalizeUrlForSource;

// Re-exported for tools.ts __testing surface and tests.
export { searchEnginesInFallbackOrder };

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

interface MergedSearchResult {
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
      const key = normalizeFetchUrl(result.url);
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
  ctx: ResearchLoopContext;
  provider: SearchProvider;
}): Promise<SearchCollection> {
  const { query, limit, index, ctx, provider } = opts;
  ctx.emit({
    type: "searching",
    index,
    query,
  });

  let outcome: SearchQueryOutcome;
  try {
    outcome = await provider.searchQuery({ query, limit, signal: ctx.signal });
  } catch (err) {
    ctx.emit({ type: "search_results", index, count: 0 });
    return {
      query,
      sources: [],
      searchedSources: [provider.name],
      warnings: [`${provider.name}: ${errorMessage(err)}`],
      sawEmptyResults: false,
    };
  }

  const merged = mergeSearchResults(
    outcome.sources.map((source) => ({
      query,
      source: source.source,
      order: source.order,
      results: source.results,
    })),
    limit,
  );
  ctx.emit({
    type: "search_results",
    index,
    count: merged.length,
  });
  return {
    query,
    sources: outcome.sources,
    searchedSources: outcome.attempted,
    warnings: outcome.warnings,
    sawEmptyResults: outcome.sawEmptyResults,
  };
}

export async function execSearch(
  args: SearchToolInput,
  ctx: ResearchLoopContext,
  searchIndex: number,
): Promise<string> {
  const queries = readSearchQueries(args);
  if (queries.length === 0) {
    return "Error: search requires `queries` to be an array of non-empty strings.";
  }

  const rawLimit = args.limit ?? ctx.defaultSearchLimit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 20);
  const provider = ctx.searchProvider ?? createScrapingSearchProvider(ctx);
  const collections = await Promise.all(
    queries.map((query, offset) =>
      collectSearchResults({
        query,
        limit,
        index: searchIndex + offset,
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
  const results = mergeSearchResults(sourceLists, limit);
  if (results.length > 0) {
    const successfulEngines = unique(
      sourceLists.map((source) => source.source),
    );
    const searchedEngines = unique(
      collections.flatMap((collection) => collection.searchedSources),
    );
    const warnings = formatWarnings(collections, queries.length > 1);
    return JSON.stringify(
      {
        ...(queries.length === 1 ? { query: queries[0] } : { queries }),
        provider: provider.name,
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
  const sawEmptyResults = collections.some(
    (collection) => collection.sawEmptyResults,
  );
  if (sawEmptyResults) {
    return JSON.stringify(
      {
        ...(queries.length === 1 ? { query: queries[0] } : { queries }),
        provider: provider.name,
        results: [],
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      null,
      2,
    );
  }
  const error = warnings.join("; ") || "all sources failed";
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
