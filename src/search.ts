import * as cheerio from "cheerio";
import type { Env } from "./env";
import { getSteel, looksBlocked } from "./steel";

export const ENGINES = ["ddg", "bing", "google"] as const;
export type Engine = (typeof ENGINES)[number];

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
  env: Env;
  query: string;
  limit?: number;
  engine?: Engine;
  country?: string;
  lang?: string;
  use_proxy?: boolean;
}): Promise<WebSearchOutcome> {
  const limit = opts.limit ?? 10;
  const engine = opts.engine ?? "ddg";
  const useProxy = opts.use_proxy ?? true;
  const steel = getSteel(opts.env);
  const serpUrl = buildSerpUrl(engine, opts.query, {
    country: opts.country,
    lang: opts.lang,
    limit,
  });

  let html: string;
  try {
    const result = await steel.scrape({
      url: serpUrl,
      format: ["html"],
      useProxy,
    });
    html = result.content?.html ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    if (status === 408 || /timeout/i.test(message)) {
      return { ok: false, error: { code: "E_STEEL_TIMEOUT", message } };
    }
    return { ok: false, error: { code: "E_STEEL_UNAVAILABLE", message } };
  }

  if (!html || looksBlocked(html)) {
    return {
      ok: false,
      error: {
        code: "E_STEEL_UNAVAILABLE",
        message: `${engine} returned an anti-bot challenge or empty body`,
      },
    };
  }

  return { ok: true, results: parseSerp(engine, html, limit) };
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

function parseSerp(engine: Engine, html: string, limit: number): SearchResult[] {
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

    const snippet = $el.find("a.result__snippet, .result__snippet").first().text().trim();

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
      const href = ($a.attr("href") ?? $el.find('a[href^="http"]').first().attr("href") ?? "").trim();
      if (!href || !/^https?:\/\//i.test(href)) return;

      const url = normalizeGoogleHref(href);
      if (!url || isGoogleInternal(url) || seen.has(url)) return;
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
    return /(^|\.)google\.[a-z.]+$/i.test(host) || host === "accounts.google.com";
  } catch {
    return true;
  }
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
