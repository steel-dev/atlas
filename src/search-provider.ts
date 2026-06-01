import {
  dedupeSearchResults,
  safeDomain,
  searchEnginesInFallbackOrder,
  webSearch,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";
import { extractHtmlWithBrowser } from "./browser-extract.js";
import { errorMessage } from "./errors.js";
import type { ResearchCtx } from "./runtime.js";

export interface SearchProvider {
  readonly name: string;
  searchQuery(opts: SearchProviderQuery): Promise<SearchQueryOutcome>;
}

export interface SearchProviderQuery {
  query: string;
  limit: number;
  signal?: AbortSignal;
}

export interface SearchSourceResults {
  source: string;
  order: number;
  results: SearchResult[];
}

export interface SearchQueryOutcome {
  query: string;
  sources: SearchSourceResults[];
  attempted: string[];
  warnings: string[];
  sawEmptyResults: boolean;
}

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

async function searchEngineWithCache(
  ctx: ResearchCtx,
  opts: { query: string; limit: number; engine: Engine },
): Promise<WebSearchOutcome> {
  const cacheKey = searchCacheKey({
    query: opts.query,
    limit: opts.limit,
    engine: opts.engine,
    useProxy: ctx.config.useProxy,
  });
  let outcomePromise = ctx.store.caches.serp.get(cacheKey);
  if (!outcomePromise) {
    outcomePromise = webSearch({
      query: opts.query,
      engine: opts.engine,
      useProxy: ctx.config.useProxy,
      limit: opts.limit,
      signal: ctx.deps.signal,
      renderPage: (url) => extractHtmlWithBrowser(ctx, url),
    });
    ctx.store.caches.serp.set(cacheKey, outcomePromise);
  }

  try {
    return await outcomePromise;
  } catch (err) {
    ctx.store.caches.serp.delete(cacheKey);
    throw err;
  }
}

export function createScrapingSearchProvider(ctx: ResearchCtx): SearchProvider {
  return {
    name: "web",
    async searchQuery({ query, limit }) {
      const engines = searchEnginesInFallbackOrder(ctx.config.defaultEngine);
      const outcomes = await Promise.all(
        engines.map(async (engine, order) => {
          try {
            return {
              engine,
              order,
              outcome: await searchEngineWithCache(ctx, {
                query,
                limit,
                engine,
              }),
            };
          } catch (err) {
            return { engine, order, error: errorMessage(err) };
          }
        }),
      );

      const sources: SearchSourceResults[] = [];
      const warnings: string[] = [];
      let sawEmptyResults = false;
      for (const entry of outcomes) {
        if ("error" in entry) {
          warnings.push(`${entry.engine}: ${entry.error}`);
          continue;
        }
        if (!entry.outcome.ok) {
          warnings.push(`${entry.engine}: ${entry.outcome.error.message}`);
          continue;
        }
        const results = dedupeSearchResults(entry.outcome.results, limit);
        if (results.length === 0) {
          sawEmptyResults = true;
          warnings.push(`${entry.engine}: no results`);
          continue;
        }
        sources.push({ source: entry.engine, order: entry.order, results });
      }

      return {
        query,
        sources,
        attempted: engines,
        warnings,
        sawEmptyResults,
      };
    },
  };
}

function failedOutcome(
  query: string,
  source: string,
  message: string,
): SearchQueryOutcome {
  return {
    query,
    sources: [],
    attempted: [source],
    warnings: [`${source}: ${message}`],
    sawEmptyResults: false,
  };
}

function singleSourceOutcome(
  query: string,
  source: string,
  results: SearchResult[],
): SearchQueryOutcome {
  if (results.length === 0) {
    return {
      query,
      sources: [],
      attempted: [source],
      warnings: [`${source}: no results`],
      sawEmptyResults: true,
    };
  }
  return {
    query,
    sources: [{ source, order: 0, results }],
    attempted: [source],
    warnings: [],
    sawEmptyResults: false,
  };
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "";
  }
}

function toResult(
  index: number,
  url: unknown,
  title: unknown,
  snippet: string,
): SearchResult | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  return {
    position: index + 1,
    title: typeof title === "string" && title.trim() ? title.trim() : url,
    url,
    snippet,
    domain: safeDomain(url),
  };
}

export interface ExaSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Exa search mode: auto, fast, deep, … (default lets Exa decide). */
  type?: string;
}

export function createExaSearchProvider(
  opts: ExaSearchProviderOptions,
): SearchProvider {
  if (!opts.apiKey) throw new Error("Exa search provider requires an apiKey");
  const endpoint = `${(opts.baseUrl ?? "https://api.exa.ai").replace(/\/+$/, "")}/search`;
  return {
    name: "exa",
    async searchQuery({ query, limit, signal }) {
      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
          },
          body: JSON.stringify({
            query,
            numResults: Math.min(Math.max(1, limit), 100),
            ...(opts.type ? { type: opts.type } : {}),
            contents: { highlights: { numSentences: 3, highlightsPerUrl: 2 } },
          }),
        });
      } catch (err) {
        return failedOutcome(query, "exa", errorMessage(err));
      }
      if (!resp.ok) {
        const body = await readErrorBody(resp);
        return failedOutcome(
          query,
          "exa",
          `HTTP ${resp.status}${body ? `: ${body}` : ""}`,
        );
      }
      let data: unknown;
      try {
        data = await resp.json();
      } catch (err) {
        return failedOutcome(
          query,
          "exa",
          `invalid JSON: ${errorMessage(err)}`,
        );
      }
      return singleSourceOutcome(query, "exa", parseExaResults(data, limit));
    },
  };
}

function parseExaResults(data: unknown, limit: number): SearchResult[] {
  const rows =
    data &&
    typeof data === "object" &&
    Array.isArray((data as { results?: unknown }).results)
      ? (data as { results: unknown[] }).results
      : [];
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const highlights = Array.isArray(record.highlights)
      ? record.highlights.filter((h): h is string => typeof h === "string")
      : [];
    const snippet =
      highlights.join(" … ").trim() ||
      (typeof record.text === "string" ? record.text.slice(0, 500).trim() : "");
    const result = toResult(results.length, record.url, record.title, snippet);
    if (result) results.push(result);
    if (results.length >= limit) break;
  }
  return results;
}

export interface BraveSearchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  country?: string;
  searchLang?: string;
}

export function createBraveSearchProvider(
  opts: BraveSearchProviderOptions,
): SearchProvider {
  if (!opts.apiKey) throw new Error("Brave search provider requires an apiKey");
  const base = `${(opts.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "")}/res/v1/web/search`;
  return {
    name: "brave",
    async searchQuery({ query, limit, signal }) {
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(Math.max(1, limit), 20)),
        extra_snippets: "true",
      });
      if (opts.country) params.set("country", opts.country);
      if (opts.searchLang) params.set("search_lang", opts.searchLang);
      let resp: Response;
      try {
        resp = await fetch(`${base}?${params.toString()}`, {
          signal,
          headers: {
            accept: "application/json",
            "x-subscription-token": opts.apiKey,
          },
        });
      } catch (err) {
        return failedOutcome(query, "brave", errorMessage(err));
      }
      if (!resp.ok) {
        const body = await readErrorBody(resp);
        return failedOutcome(
          query,
          "brave",
          `HTTP ${resp.status}${body ? `: ${body}` : ""}`,
        );
      }
      let data: unknown;
      try {
        data = await resp.json();
      } catch (err) {
        return failedOutcome(
          query,
          "brave",
          `invalid JSON: ${errorMessage(err)}`,
        );
      }
      return singleSourceOutcome(
        query,
        "brave",
        parseBraveResults(data, limit),
      );
    },
  };
}

function parseBraveResults(data: unknown, limit: number): SearchResult[] {
  const web =
    data && typeof data === "object"
      ? (data as { web?: unknown }).web
      : undefined;
  const rows =
    web &&
    typeof web === "object" &&
    Array.isArray((web as { results?: unknown }).results)
      ? (web as { results: unknown[] }).results
      : [];
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const extra = Array.isArray(record.extra_snippets)
      ? record.extra_snippets.filter((s): s is string => typeof s === "string")
      : [];
    const snippet =
      (typeof record.description === "string" ? record.description : "") ||
      extra.join(" … ");
    const result = toResult(
      results.length,
      record.url,
      record.title,
      snippet.trim(),
    );
    if (result) results.push(result);
    if (results.length >= limit) break;
  }
  return results;
}

export type SearchProviderKind = "web" | "exa" | "brave";

export interface SearchProviderResolution {
  instance?: SearchProvider;
  kind?: string;
  exaApiKey?: string;
  braveApiKey?: string;
}

export function resolveSearchProvider(
  ctx: ResearchCtx,
  opts: SearchProviderResolution,
): SearchProvider {
  if (opts.instance) return opts.instance;
  const kind = (opts.kind?.trim() || "web").toLowerCase();
  switch (kind) {
    case "web":
    case "scraping":
    case "serp":
      return createScrapingSearchProvider(ctx);
    case "exa": {
      if (!opts.exaApiKey) {
        throw new Error(
          "search provider exa requires ATLAS_EXA_API_KEY or EXA_API_KEY",
        );
      }
      return createExaSearchProvider({ apiKey: opts.exaApiKey });
    }
    case "brave": {
      if (!opts.braveApiKey) {
        throw new Error(
          "search provider brave requires ATLAS_BRAVE_API_KEY or BRAVE_API_KEY",
        );
      }
      return createBraveSearchProvider({ apiKey: opts.braveApiKey });
    }
    default:
      throw new Error(
        `unknown search provider "${kind}" (expected web, exa, or brave)`,
      );
  }
}
