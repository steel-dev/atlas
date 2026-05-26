import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { looksBlocked } from "./steel.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; AtlasResearchBot/0.1; +https://github.com/steel-experiments/atlas)";
const MIN_PLAIN_MARKDOWN_CHARS = 500;
const MAX_PLAIN_INPUT_CHARS = 1_000_000;

export interface PlainPageMetadata {
  fetch_method: "plain";
  content_type: string;
  raw_chars: number;
  raw_truncated: boolean;
  markdown_chars: number;
  extraction_notes: string[];
}

export interface PlainPage {
  markdown: string;
  title: string | null;
  metadata: PlainPageMetadata;
}

export type PlainPageOutcome =
  | { ok: true; page: PlainPage }
  | { ok: false; reason: string };

export async function fetchPlainPage(opts: {
  url: string;
  signal?: AbortSignal;
}): Promise<PlainPageOutcome> {
  let response: Response;
  try {
    response = await fetch(opts.url, {
      signal: opts.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.8,*/*;q=0.5",
      },
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!isReadableContentType(contentType)) {
    return { ok: false, reason: `Unsupported content-type: ${contentType || "unknown"}` };
  }

  const rawBody = await response.text();
  const rawTruncated = rawBody.length > MAX_PLAIN_INPUT_CHARS;
  const raw = rawBody.slice(0, MAX_PLAIN_INPUT_CHARS);
  if (!raw.trim()) return { ok: false, reason: "Empty body" };
  if (looksBlocked(raw)) return { ok: false, reason: "Blocked or challenge page" };

  const page = contentType.includes("html")
    ? htmlToMarkdown(raw, opts.url)
    : textToMarkdown(raw);
  const extractionNotes = contentType.includes("html")
    ? [
        "Extracted with Atlas' lightweight static HTML parser; browser-rendered or script-loaded content may be missing.",
      ]
    : ["Fetched as readable text without browser rendering."];
  if (rawTruncated) {
    extractionNotes.push(
      `Plain fetch input was truncated at ${MAX_PLAIN_INPUT_CHARS.toLocaleString()} chars before extraction.`,
    );
  }
  page.metadata = {
    fetch_method: "plain",
    content_type: contentType || "unknown",
    raw_chars: rawBody.length,
    raw_truncated: rawTruncated,
    markdown_chars: page.markdown.length,
    extraction_notes: extractionNotes,
  };

  if (page.markdown.length < MIN_PLAIN_MARKDOWN_CHARS) {
    return {
      ok: false,
      reason: `Plain fetch returned too little readable text (${page.markdown.length} chars)`,
    };
  }

  return { ok: true, page };
}

function isReadableContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    !lower ||
    lower.includes("text/html") ||
    lower.includes("application/xhtml+xml") ||
    lower.includes("text/plain") ||
    lower.includes("text/markdown") ||
    lower.includes("application/json")
  );
}

function textToMarkdown(raw: string): PlainPage {
  const markdown = normalizeWhitespace(raw);
  const title =
    markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.replace(/^#+\s*/, "")
      .slice(0, 160) ?? null;
  return { markdown, title, metadata: emptyPlainMetadata() };
}

function htmlToMarkdown(html: string, baseUrl: string): PlainPage {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, canvas, iframe, nav, footer, header, form").remove();

  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    null;

  const root = bestContentRoot($);
  const markdown = normalizeMarkdown(renderChildren($, root, baseUrl));
  return { markdown, title: title || null, metadata: emptyPlainMetadata() };
}

function emptyPlainMetadata(): PlainPageMetadata {
  return {
    fetch_method: "plain",
    content_type: "unknown",
    raw_chars: 0,
    raw_truncated: false,
    markdown_chars: 0,
    extraction_notes: [],
  };
}

function bestContentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const candidates = $("article, main, [role='main'], .content, #content, body").toArray();
  let best = $("body").first();
  let bestLength = best.text().trim().length;

  for (const el of candidates) {
    const candidate = $(el);
    const length = candidate.text().trim().length;
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
  }

  return best;
}

function renderChildren(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<AnyNode>,
  baseUrl: string,
): string {
  return el
    .contents()
    .toArray()
    .map((child) => renderNode($, child, baseUrl))
    .join("");
}

function renderNode(
  $: cheerio.CheerioAPI,
  node: AnyNode,
  baseUrl: string,
): string {
  const $node = $(node);
  const type = node.type;
  if (type === "text") return (node as { data?: string }).data ?? "";
  if (type !== "tag") return "";

  const tag = ((node as { tagName?: string }).tagName ?? "").toLowerCase();
  const inner = renderChildren($, $node, baseUrl).trim();
  if (!inner && tag !== "br") return "";

  switch (tag) {
    case "h1":
      return `\n\n# ${inner}\n\n`;
    case "h2":
      return `\n\n## ${inner}\n\n`;
    case "h3":
      return `\n\n### ${inner}\n\n`;
    case "h4":
    case "h5":
    case "h6":
      return `\n\n#### ${inner}\n\n`;
    case "p":
    case "section":
    case "article":
    case "main":
    case "div":
      return `\n\n${inner}\n\n`;
    case "br":
      return "\n";
    case "li":
      return `\n- ${inner}`;
    case "pre":
      return `\n\n\`\`\`\n${$node.text().trim()}\n\`\`\`\n\n`;
    case "code":
      return `\`${$node.text().trim()}\``;
    case "a": {
      const href = $node.attr("href");
      const absoluteHref = href ? absoluteUrl(href, baseUrl) : null;
      return absoluteHref && inner !== absoluteHref
        ? `[${inner}](${absoluteHref})`
        : inner;
    }
    case "td":
    case "th":
      return `${inner} | `;
    case "tr":
      return `\n${inner}`;
    default:
      return inner;
  }
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .trim();
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const __testing = {
  htmlToMarkdown,
  textToMarkdown,
};
