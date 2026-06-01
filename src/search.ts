import * as cheerio from "cheerio";
import { looksBlocked } from "./steel.js";
import { normalizeUrlForSource } from "./url.js";

export const ENGINES = ["ddg", "bing", "google"] as const;
export type Engine = (typeof ENGINES)[number];
export const DEFAULT_SEARCH_ENGINE: Engine = "ddg";
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (compatible; AtlasResearchBot/0.1; +https://github.com/steel-experiments/atlas)";

export interface SearchResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface WebSearchError {
  code: "E_STEEL_TIMEOUT" | "E_STEEL_UNAVAILABLE";
  message: string;
}

export type WebSearchOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; error: WebSearchError };

export async function webSearch(opts: {
  query: string;
  limit?: number;
  engine?: Engine;
  country?: string;
  lang?: string;
  useProxy?: boolean;
  signal?: AbortSignal;
  renderPage?: (
    url: string,
  ) => Promise<{ html: string; finalUrl?: string; title?: string }>;
}): Promise<WebSearchOutcome> {
  const limit = opts.limit ?? 10;
  const engine = opts.engine ?? "ddg";
  const useProxy = opts.useProxy ?? false;
  const serpUrl = buildSerpUrl(engine, opts.query, {
    country: opts.country,
    lang: opts.lang,
    limit,
  });

  let html: string;
  let plainFailure: string | undefined;
  if (!useProxy) {
    const plain = await fetchPlainSerpHtml(serpUrl, opts.signal);
    if (plain.ok) {
      html = plain.html;
      const results = parseSerp(engine, html, limit);
      if (results.length > 0) return { ok: true, results };
      plainFailure = "plain fetch parsed 0 results";
    } else {
      plainFailure = plain.reason;
    }
  }

  try {
    if (!opts.renderPage) {
      const message = plainFailure
        ? `plain fetch failed (${plainFailure}); browser rendering is unavailable`
        : "browser rendering is unavailable";
      return { ok: false, error: { code: "E_STEEL_UNAVAILABLE", message } };
    }
    const result = await opts.renderPage(serpUrl);
    html = result.html;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    if (status === 429) throw err;
    const combinedMessage = plainFailure
      ? `plain fetch failed (${plainFailure}); browser rendering failed: ${message}`
      : message;
    if (status === 408 || /timeout/i.test(message)) {
      return {
        ok: false,
        error: { code: "E_STEEL_TIMEOUT", message: combinedMessage },
      };
    }
    return {
      ok: false,
      error: { code: "E_STEEL_UNAVAILABLE", message: combinedMessage },
    };
  }

  if (!html || looksBlocked(html)) {
    const message = plainFailure
      ? `${engine} returned an anti-bot challenge or empty body after plain fetch failed (${plainFailure})`
      : `${engine} returned an anti-bot challenge or empty body`;
    return {
      ok: false,
      error: {
        code: "E_STEEL_UNAVAILABLE",
        message,
      },
    };
  }

  return { ok: true, results: parseSerp(engine, html, limit) };
}

type PlainSerpOutcome =
  | { ok: true; html: string }
  | { ok: false; reason: string };

async function fetchPlainSerpHtml(
  url: string,
  signal?: AbortSignal,
): Promise<PlainSerpOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      headers: {
        "user-agent": SEARCH_USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
      },
    });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/html|text/i.test(contentType)) {
    return { ok: false, reason: `Unsupported content-type: ${contentType}` };
  }

  const html = await response.text();
  if (!html.trim()) return { ok: false, reason: "Empty body" };
  if (looksBlocked(html))
    return { ok: false, reason: "Blocked or challenge page" };

  return { ok: true, html };
}

function buildSerpUrl(
  engine: Engine,
  query: string,
  opts: { country?: string; lang?: string; limit: number },
): string {
  switch (engine) {
    case "ddg": {
      const params = new URLSearchParams({ q: query });
      if (opts.lang) params.set("kl", `${opts.country ?? "us"}-${opts.lang}`);
      return `https://html.duckduckgo.com/html/?${params.toString()}`;
    }
    case "bing": {
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(opts.limit + 5, 50)),
      });
      if (opts.country) params.set("cc", opts.country.toUpperCase());
      if (opts.lang) params.set("setlang", opts.lang);
      return `https://www.bing.com/search?${params.toString()}`;
    }
    case "google": {
      const params = new URLSearchParams({
        q: query,
        num: String(Math.min(opts.limit + 5, 50)),
      });
      if (opts.country) params.set("gl", opts.country.toLowerCase());
      if (opts.lang) params.set("hl", opts.lang.toLowerCase());
      return `https://www.google.com/search?${params.toString()}`;
    }
    default: {
      const _exhaustive: never = engine;
      throw new Error(`Unhandled engine: ${_exhaustive}`);
    }
  }
}

function parseSerp(
  engine: Engine,
  html: string,
  limit: number,
): SearchResult[] {
  switch (engine) {
    case "ddg":
      return parseDdg(html, limit);
    case "bing":
      return parseBing(html, limit);
    case "google":
      return parseGoogle(html, limit);
  }
}

function parseDdg(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $("div.result, div.web-result").each((_idx, el) => {
    if (results.length >= limit) return false;
    const $el = $(el);
    const $a = $el.find("a.result__a").first();
    const title = $a.text().trim();
    const rawHref = ($a.attr("href") ?? "").trim();
    if (!title || !rawHref) return;

    const url = unwrapDdgHref(rawHref);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const snippet = $el
      .find("a.result__snippet, .result__snippet")
      .first()
      .text()
      .trim();

    results.push({
      position: results.length + 1,
      title,
      url,
      snippet,
      domain: safeDomain(url),
    });
    return;
  });

  return results;
}

function parseBing(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $("li.b_algo").each((_idx, el) => {
    if (results.length >= limit) return false;
    const $el = $(el);
    const $a = $el.find("h2 a").first();
    const title = $a.text().trim();
    const href = ($a.attr("href") ?? "").trim();
    if (!title || !href || !/^https?:\/\//i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);

    const snippet =
      $el.find(".b_caption p").first().text().trim() ||
      $el.find(".b_caption").first().text().trim() ||
      $el.find(".b_snippet").first().text().trim();

    results.push({
      position: results.length + 1,
      title,
      url: href,
      snippet,
      domain: safeDomain(href),
    });
    return;
  });

  return results;
}

function parseGoogle(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  const containerSelectors = [
    "div.g",
    "div[data-hveid][data-ved]",
    "div.tF2Cxc",
    "div.Gx5Zad",
  ];

  for (const sel of containerSelectors) {
    $(sel).each((_idx, el) => {
      if (results.length >= limit) return false;
      const $el = $(el);
      const $h3 = $el.find("h3").first();
      const title = $h3.text().trim();
      if (!title) return;

      const $a = $h3.closest("a");
      const href = (
        $a.attr("href") ??
        $el.find('a[href^="http"]').first().attr("href") ??
        ""
      ).trim();
      if (!href) return;

      const url = normalizeGoogleHref(href);
      if (
        !url ||
        !/^https?:\/\//i.test(url) ||
        isGoogleInternal(url) ||
        seen.has(url)
      )
        return;
      seen.add(url);

      const snippet =
        $el.find("div.VwiC3b").first().text().trim() ||
        $el.find('div[data-sncf="1"]').first().text().trim() ||
        $el.find('div[data-sncf="2"]').first().text().trim() ||
        $el.find("span.aCOpRe").first().text().trim() ||
        "";

      results.push({
        position: results.length + 1,
        title,
        url,
        snippet,
        domain: safeDomain(url),
      });
      return;
    });
    if (results.length >= limit) break;
  }

  return results;
}

function unwrapDdgHref(href: string): string | null {
  if (href.startsWith("//duckduckgo.com/l/") || href.includes("/l/?uddg=")) {
    try {
      const base = href.startsWith("//") ? `https:${href}` : href;
      const u = new URL(base, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      return real && /^https?:\/\//i.test(real) ? real : null;
    } catch {
      return null;
    }
  }
  return /^https?:\/\//i.test(href) ? href : null;
}

function normalizeGoogleHref(href: string): string | null {
  if (href.startsWith("/url?")) {
    try {
      const u = new URL(href, "https://www.google.com");
      return u.searchParams.get("q") ?? u.searchParams.get("url");
    } catch {
      return null;
    }
  }
  return href;
}

function isGoogleInternal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      /(^|\.)google\.[a-z.]+$/i.test(host) || host === "accounts.google.com"
    );
  } catch {
    return true;
  }
}

export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function searchEnginesForFusion(defaultEngine: Engine): Engine[] {
  return [
    defaultEngine,
    ...ENGINES.filter((engine) => engine !== defaultEngine),
  ];
}

export function dedupeSearchResults(
  results: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrlForSource(result.url);
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

export const __testing = {
  buildSerpUrl,
  fetchPlainSerpHtml,
  parseSerp,
  parseDdg,
  parseBing,
  parseGoogle,
  unwrapDdgHref,
  normalizeGoogleHref,
};
