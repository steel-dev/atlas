import { generateText, type LanguageModel, type ToolSet } from "ai";
import { errorMessage } from "../errors.js";
import { readEnv } from "../env.js";
import { normalizeUrlForSource } from "../url.js";

export interface SearchResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface SearchQuery {
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly id: string;
  search(q: SearchQuery): Promise<SearchResult[]>;
}

export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
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

async function readErrorBody(resp: Response): Promise<string> {
  try {
    const text = (await resp.text()).trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "";
  }
}

function clampLimit(limit: number | undefined, max: number): number {
  return Math.min(Math.max(1, Math.floor(limit ?? 8)), max);
}

export interface TavilyOptions {
  apiKey?: string;
  baseUrl?: string;
}

export function tavily(opts: TavilyOptions = {}): SearchProvider {
  const apiKey =
    opts.apiKey ?? readEnv("ATLAS_TAVILY_API_KEY", "TAVILY_API_KEY");
  if (!apiKey) {
    throw new Error(
      "tavily() requires an apiKey (or set ATLAS_TAVILY_API_KEY / TAVILY_API_KEY)",
    );
  }
  const endpoint = `${(opts.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "")}/search`;
  return {
    id: "tavily",
    async search({ query, maxResults, signal }) {
      const resp = await fetch(endpoint, {
        method: "POST",
        signal: signal ?? null,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: clampLimit(maxResults, 20),
        }),
      });
      if (!resp.ok) {
        throw new Error(`tavily: HTTP ${resp.status}: ${await readErrorBody(resp)}`);
      }
      const data = (await resp.json()) as { results?: unknown[] };
      const rows = Array.isArray(data.results) ? data.results : [];
      const results: SearchResult[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const snippet =
          typeof record.content === "string"
            ? record.content.slice(0, 500).trim()
            : "";
        const result = toResult(
          results.length,
          record.url,
          record.title,
          snippet,
        );
        if (result) results.push(result);
      }
      return results;
    },
  };
}

export interface ExaOptions {
  apiKey?: string;
  baseUrl?: string;
  type?: string;
}

export function exa(opts: ExaOptions = {}): SearchProvider {
  const apiKey = opts.apiKey ?? readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY");
  if (!apiKey) {
    throw new Error(
      "exa() requires an apiKey (or set ATLAS_EXA_API_KEY / EXA_API_KEY)",
    );
  }
  const endpoint = `${(opts.baseUrl ?? "https://api.exa.ai").replace(/\/+$/, "")}/search`;
  return {
    id: "exa",
    async search({ query, maxResults, signal }) {
      const resp = await fetch(endpoint, {
        method: "POST",
        signal: signal ?? null,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          numResults: clampLimit(maxResults, 100),
          ...(opts.type ? { type: opts.type } : {}),
          contents: { highlights: { numSentences: 3, highlightsPerUrl: 2 } },
        }),
      });
      if (!resp.ok) {
        throw new Error(`exa: HTTP ${resp.status}: ${await readErrorBody(resp)}`);
      }
      const data = (await resp.json()) as { results?: unknown[] };
      const rows = Array.isArray(data.results) ? data.results : [];
      const results: SearchResult[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const highlights = Array.isArray(record.highlights)
          ? record.highlights.filter((h): h is string => typeof h === "string")
          : [];
        const snippet =
          highlights.join(" … ").trim() ||
          (typeof record.text === "string"
            ? record.text.slice(0, 500).trim()
            : "");
        const result = toResult(
          results.length,
          record.url,
          record.title,
          snippet,
        );
        if (result) results.push(result);
      }
      return results;
    },
  };
}

export interface BraveOptions {
  apiKey?: string;
  baseUrl?: string;
  country?: string;
  searchLang?: string;
}

export function brave(opts: BraveOptions = {}): SearchProvider {
  const apiKey =
    opts.apiKey ?? readEnv("ATLAS_BRAVE_API_KEY", "BRAVE_API_KEY");
  if (!apiKey) {
    throw new Error(
      "brave() requires an apiKey (or set ATLAS_BRAVE_API_KEY / BRAVE_API_KEY)",
    );
  }
  const base = `${(opts.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "")}/res/v1/web/search`;
  return {
    id: "brave",
    async search({ query, maxResults, signal }) {
      const params = new URLSearchParams({
        q: query,
        count: String(clampLimit(maxResults, 20)),
        extra_snippets: "true",
      });
      if (opts.country) params.set("country", opts.country);
      if (opts.searchLang) params.set("search_lang", opts.searchLang);
      const resp = await fetch(`${base}?${params.toString()}`, {
        signal: signal ?? null,
        headers: {
          accept: "application/json",
          "x-subscription-token": apiKey,
        },
      });
      if (!resp.ok) {
        throw new Error(
          `brave: HTTP ${resp.status}: ${await readErrorBody(resp)}`,
        );
      }
      const data = (await resp.json()) as { web?: { results?: unknown[] } };
      const rows = Array.isArray(data.web?.results) ? data.web.results : [];
      const results: SearchResult[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const extra = Array.isArray(record.extra_snippets)
          ? record.extra_snippets.filter(
              (s): s is string => typeof s === "string",
            )
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
      }
      return results;
    },
  };
}

export interface NativeModelSearchOptions {
  model: Exclude<LanguageModel, string>;
}

export function nativeModelSearch(
  opts: NativeModelSearchOptions,
): SearchProvider {
  return {
    id: "model-native",
    async search({ query, maxResults, signal }) {
      const tools = await nativeSearchTools(opts.model);
      const limit = clampLimit(maxResults, 10);
      const result = await generateText({
        model: opts.model,
        prompt:
          `Search the web for: ${query}\n\n` +
          `Run one web search and list the ${limit} most relevant distinct result pages. ` +
          "Do not answer the question; just surface the sources. " +
          "Write one line per result in the form `<plain url> :: <one-sentence summary of what the page contains>`, with no markdown links.",
        tools,
        maxOutputTokens: 1_500,
        abortSignal: signal,
      });
      const snippets = snippetsByUrl(result.text);
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const source of result.sources) {
        if (source.sourceType !== "url") continue;
        const key = normalizeUrlForSource(source.url);
        if (seen.has(key)) continue;
        seen.add(key);
        const parsed = toResult(
          results.length,
          source.url,
          source.title,
          snippets.get(key) ?? "",
        );
        if (parsed) results.push(parsed);
        if (results.length >= limit) break;
      }
      return results;
    },
  };
}

function snippetsByUrl(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /(https?:\/\/\S+?)[)\]>.,]*\s*::\s*(\S.*)/.exec(line);
    if (!match) continue;
    const key = normalizeUrlForSource(match[1]);
    if (!map.has(key)) map.set(key, match[2].trim().slice(0, 500));
  }
  return map;
}

async function nativeSearchTools(
  model: Exclude<LanguageModel, string>,
): Promise<ToolSet> {
  const provider = model.provider.toLowerCase();
  if (provider.includes("anthropic")) {
    const { anthropic } = await import("@ai-sdk/anthropic");
    return {
      web_search: anthropic.tools.webSearch_20250305({ maxUses: 1 }),
    };
  }
  if (provider.includes("openai")) {
    const { openai } = await import("@ai-sdk/openai");
    return { web_search: openai.tools.webSearch({}) };
  }
  if (provider.includes("google")) {
    const { google } = await import("@ai-sdk/google");
    return { google_search: google.tools.googleSearch({}) };
  }
  throw new Error(
    `nativeModelSearch: provider "${model.provider}" has no known server-side search tool; configure a search adapter (tavily(), exa(), brave())`,
  );
}

export interface MergedSearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  providerRank: number;
  providers: string[];
  score: number;
}

const RRF_K = 60;

export function mergeSearchResults(
  lists: Array<{ provider: string; results: SearchResult[] }>,
  limit: number,
): MergedSearchResult[] {
  const byUrl = new Map<string, MergedSearchResult>();
  for (const list of lists) {
    for (const result of list.results) {
      const key = normalizeUrlForSource(result.url);
      const score = 1 / (RRF_K + result.position);
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, {
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          provider: list.provider,
          providerRank: result.position,
          providers: [list.provider],
          score,
        });
        continue;
      }
      existing.score += score;
      if (!existing.providers.includes(list.provider)) {
        existing.providers.push(list.provider);
      }
      if (result.position < existing.providerRank) {
        existing.title = result.title;
        existing.url = result.url;
        existing.snippet = result.snippet || existing.snippet;
        existing.provider = list.provider;
        existing.providerRank = result.position;
      }
    }
  }
  return [...byUrl.values()]
    .sort(
      (a, b) => b.score - a.score || a.providerRank - b.providerRank,
    )
    .slice(0, limit);
}

export interface ResolvedSearch {
  providers: SearchProvider[];
  run(q: SearchQuery): Promise<{
    merged: MergedSearchResult[];
    warnings: string[];
  }>;
}

export function combineSearchProviders(
  providers: SearchProvider[],
): ResolvedSearch {
  return {
    providers,
    async run(q) {
      const warnings: string[] = [];
      const lists = await Promise.all(
        providers.map(async (provider) => {
          try {
            return { provider: provider.id, results: await provider.search(q) };
          } catch (err) {
            warnings.push(`${provider.id}: ${errorMessage(err)}`);
            return { provider: provider.id, results: [] };
          }
        }),
      );
      return {
        merged: mergeSearchResults(lists, clampLimit(q.maxResults, 20)),
        warnings,
      };
    },
  };
}

export function defaultSearchProviders(
  model: Exclude<LanguageModel, string>,
): SearchProvider[] {
  const providers: SearchProvider[] = [];
  if (readEnv("ATLAS_TAVILY_API_KEY", "TAVILY_API_KEY")) {
    providers.push(tavily());
  }
  if (readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY")) {
    providers.push(exa());
  }
  if (readEnv("ATLAS_BRAVE_API_KEY", "BRAVE_API_KEY")) {
    providers.push(brave());
  }
  if (providers.length > 0) return providers;
  return [nativeModelSearch({ model })];
}
