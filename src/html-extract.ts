import * as cheerio from "cheerio";
import type { SourceDiscoveredLink } from "./sources.js";
import { normalizeUrlForSource } from "./url.js";

export interface HtmlPageMetadata {
  canonical?: string;
  author?: string;
  articleAuthor?: string;
  publishedTime?: string;
  modifiedTime?: string;
  description?: string;
  language?: string;
  jsonLd?: unknown;
}

export interface HtmlMarkdownExtraction {
  title: string;
  markdown: string;
  links: SourceDiscoveredLink[];
  metadata: HtmlPageMetadata;
}

const DEFAULT_LINK_LIMIT = 200;

export function htmlToMarkdown(
  html: string,
  url: string,
  opts: { linkLimit?: number } = {},
): HtmlMarkdownExtraction {
  const $ = cheerio.load(html);
  const metadata = extractHtmlMetadata($, url);
  $("script, style, noscript, svg, canvas, template").remove();
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    url;
  const root = $("main").first().length
    ? $("main").first()
    : $("article").first().length
      ? $("article").first()
      : $("body").first();
  const blocks: string[] = [];
  root
    .find("h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th")
    .each((_idx, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (!text) return;
      if (/^h[1-6]$/.test(tag)) {
        const depth = Number(tag[1]);
        blocks.push(`${"#".repeat(depth)} ${text}`);
      } else if (tag === "li") {
        blocks.push(`- ${text}`);
      } else {
        blocks.push(text);
      }
    });
  const markdown = (blocks.length > 0 ? blocks.join("\n\n") : root.text())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title,
    markdown,
    links: extractLinks($, url, opts.linkLimit ?? DEFAULT_LINK_LIMIT),
    metadata,
  };
}

function extractLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  limit: number,
): SourceDiscoveredLink[] {
  const links: SourceDiscoveredLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_idx, el) => {
    if (links.length >= limit) return false;
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(absolute)) return;
    const normalized = normalizeUrlForSource(absolute);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const title = $(el).text().replace(/\s+/g, " ").trim();
    links.push({
      url: absolute,
      ...(title ? { title: title.slice(0, 200) } : {}),
    });
  });
  return links;
}

function extractHtmlMetadata(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): HtmlPageMetadata {
  const meta = (selector: string) => $(selector).attr("content")?.trim();
  const canonical = normalizeOptionalUrl(
    $('link[rel="canonical"]').first().attr("href"),
    baseUrl,
  );
  const jsonLd = $("script[type='application/ld+json']")
    .toArray()
    .map((el) => parseJsonLd($(el).text()))
    .filter((value): value is unknown => value !== undefined);
  return {
    ...(canonical ? { canonical } : {}),
    ...(meta('meta[name="author"]') ? { author: meta('meta[name="author"]') } : {}),
    ...(meta('meta[property="article:author"]')
      ? { articleAuthor: meta('meta[property="article:author"]') }
      : {}),
    ...(meta('meta[property="article:published_time"]') ||
    meta('meta[name="date"]') ||
    meta('meta[name="pubdate"]')
      ? {
          publishedTime:
            meta('meta[property="article:published_time"]') ||
            meta('meta[name="date"]') ||
            meta('meta[name="pubdate"]'),
        }
      : {}),
    ...(meta('meta[property="article:modified_time"]') ||
    meta('meta[name="last-modified"]')
      ? {
          modifiedTime:
            meta('meta[property="article:modified_time"]') ||
            meta('meta[name="last-modified"]'),
        }
      : {}),
    ...(meta('meta[name="description"]') ||
    meta('meta[property="og:description"]')
      ? {
          description:
            meta('meta[name="description"]') ||
            meta('meta[property="og:description"]'),
        }
      : {}),
    ...($("html").attr("lang")?.trim()
      ? { language: $("html").attr("lang")?.trim() }
      : {}),
    ...(jsonLd.length === 1
      ? { jsonLd: jsonLd[0] }
      : jsonLd.length > 1
        ? { jsonLd }
        : {}),
  };
}

function normalizeOptionalUrl(
  rawUrl: string | undefined,
  baseUrl: string,
): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function parseJsonLd(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
