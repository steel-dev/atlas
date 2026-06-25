import * as cheerio from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";
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

interface HtmlMarkdownExtraction {
  title: string;
  markdown: string;
  links: SourceDiscoveredLink[];
  metadata: HtmlPageMetadata;
}

const DEFAULT_LINK_LIMIT = 200;

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

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
  const rootElement = root.get(0);
  const blocks =
    rootElement && isElement(rootElement)
      ? childBlocks(rootElement.children, url)
      : [];
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

function isElement(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

function isText(node: AnyNode): node is Text {
  return node.type === "text";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function childBlocks(children: AnyNode[], baseUrl: string): string[] {
  const blocks: string[] = [];
  let inline = "";
  const flush = (): void => {
    const text = collapse(inline);
    inline = "";
    if (text) blocks.push(text);
  };
  for (const child of children) {
    if (isText(child)) {
      inline += child.data;
      continue;
    }
    if (!isElement(child)) continue;
    const tag = child.name.toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      flush();
      blocks.push(...elementBlocks(child, tag, baseUrl));
    } else {
      inline += inlineText(child, baseUrl);
    }
  }
  flush();
  return blocks;
}

function elementBlocks(el: Element, tag: string, baseUrl: string): string[] {
  if (/^h[1-6]$/.test(tag)) {
    const text = collapse(inlineChildren(el.children, baseUrl));
    return text ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
  }
  switch (tag) {
    case "p":
    case "figcaption":
    case "caption":
    case "summary":
    case "address":
    case "dt": {
      const text = collapse(inlineChildren(el.children, baseUrl));
      return text ? [text] : [];
    }
    case "blockquote": {
      const inner = childBlocks(el.children, baseUrl);
      if (inner.length === 0) return [];
      return [
        inner
          .join("\n\n")
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      ];
    }
    case "pre": {
      const fence = codeFence(el);
      return fence ? [fence] : [];
    }
    case "ul":
    case "ol": {
      const list = renderList(el, tag === "ol", baseUrl);
      return list ? [list] : [];
    }
    case "table":
      return renderTable(el, baseUrl);
    case "dl":
      return renderDefinitionList(el, baseUrl);
    case "hr":
      return [];
    default:
      return childBlocks(el.children, baseUrl);
  }
}

function inlineChildren(children: AnyNode[], baseUrl: string): string {
  let out = "";
  for (const child of children) {
    if (isText(child)) out += child.data;
    else if (isElement(child)) out += inlineText(child, baseUrl);
  }
  return out;
}

function inlineText(el: Element, baseUrl: string): string {
  const tag = el.name.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "img" || tag === "wbr") return "";
  if (tag === "a") return markdownLink(el, baseUrl);
  if (tag === "code" || tag === "kbd" || tag === "samp") {
    return inlineCode(collapse(rawText(el)));
  }
  const inner = inlineChildren(el.children, baseUrl);
  return BLOCK_TAGS.has(tag) ? ` ${inner} ` : inner;
}

function inlineCode(text: string): string {
  if (!text) return "";
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function markdownLink(el: Element, baseUrl: string): string {
  const inner = collapse(inlineChildren(el.children, baseUrl));
  const href = resolveHttpUrl(el.attribs?.href, baseUrl);
  if (!href) return inner;
  if (!inner) return "";
  if (inner === href) return href;
  const target = /[()\s]/.test(href) ? `<${href}>` : href;
  return `[${inner}](${target})`;
}

function resolveHttpUrl(
  rawHref: string | undefined,
  baseUrl: string,
): string | null {
  const href = (rawHref ?? "").trim();
  if (!href || href.startsWith("#")) return null;
  if (/^(?:javascript|mailto|tel|data):/i.test(href)) return null;
  try {
    const absolute = new URL(href, baseUrl).toString();
    return /^https?:\/\//i.test(absolute) ? absolute : null;
  } catch {
    return null;
  }
}

function renderList(el: Element, ordered: boolean, baseUrl: string): string {
  const lines: string[] = [];
  let index = 0;
  for (const child of el.children) {
    if (!isElement(child)) continue;
    const tag = child.name.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      const nested = renderList(child, tag === "ol", baseUrl);
      if (nested) {
        lines.push(...nested.split("\n").map((line) => `  ${line}`));
      }
      continue;
    }
    if (tag !== "li") continue;
    const inner = childBlocks(child.children, baseUrl);
    if (inner.length === 0) continue;
    index += 1;
    const marker = ordered ? `${index}. ` : "- ";
    const innerLines = inner.join("\n").split("\n");
    lines.push(marker + innerLines[0]);
    const pad = " ".repeat(marker.length);
    for (const line of innerLines.slice(1)) {
      lines.push(line ? pad + line : "");
    }
  }
  return lines.join("\n");
}

function renderTable(el: Element, baseUrl: string): string[] {
  const blocks: string[] = [];
  const rows: string[][] = [];
  const visitRows = (children: AnyNode[]): void => {
    for (const child of children) {
      if (!isElement(child)) continue;
      const tag = child.name.toLowerCase();
      if (tag === "tr") {
        const cells: string[] = [];
        for (const cell of child.children) {
          if (!isElement(cell)) continue;
          const cellTag = cell.name.toLowerCase();
          if (cellTag === "td" || cellTag === "th") {
            cells.push(cellText(cell, baseUrl));
          }
        }
        if (cells.length > 0) rows.push(cells);
      } else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
        visitRows(child.children);
      } else if (tag === "caption") {
        const caption = collapse(inlineChildren(child.children, baseUrl));
        if (caption) blocks.push(caption);
      }
    }
  };
  visitRows(el.children);
  if (rows.length === 0) return blocks;
  const width = Math.max(...rows.map((row) => row.length));
  const padded = (row: string[]): string[] => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ];
  const line = (row: string[]): string => `| ${padded(row).join(" | ")} |`;
  const lines = [
    line(rows[0]),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map(line),
  ];
  blocks.push(lines.join("\n"));
  return blocks;
}

function cellText(el: Element, baseUrl: string): string {
  return collapse(inlineChildren(el.children, baseUrl)).replace(/\|/g, "\\|");
}

function renderDefinitionList(el: Element, baseUrl: string): string[] {
  const lines: string[] = [];
  let terms: string[] = [];
  let defs: string[] = [];
  const flushPair = (): void => {
    const term = terms.filter(Boolean).join(", ");
    const def = defs.filter(Boolean).join("; ");
    terms = [];
    defs = [];
    if (!term && !def) return;
    lines.push(term && def ? `- ${term}: ${def}` : `- ${term || def}`);
  };
  const visit = (children: AnyNode[]): void => {
    for (const child of children) {
      if (!isElement(child)) continue;
      const tag = child.name.toLowerCase();
      if (tag === "dt") {
        if (defs.length > 0) flushPair();
        terms.push(collapse(inlineChildren(child.children, baseUrl)));
      } else if (tag === "dd") {
        defs.push(collapse(inlineChildren(child.children, baseUrl)));
      } else if (tag === "div") {
        visit(child.children);
      }
    }
  };
  visit(el.children);
  flushPair();
  return lines.length > 0 ? [lines.join("\n")] : [];
}

function codeFence(el: Element): string {
  const text = rawText(el).replace(/^\n+/, "").replace(/\s+$/, "");
  if (!collapse(text)) return "";
  const lang = codeLanguage(el);
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}${lang}\n${text}\n${fence}`;
}

function codeLanguage(el: Element): string {
  const classes = [el.attribs?.class ?? ""];
  for (const child of el.children) {
    if (isElement(child) && child.name.toLowerCase() === "code") {
      classes.push(child.attribs?.class ?? "");
    }
  }
  const match = /(?:language|lang)-([\w+-]+)/i.exec(classes.join(" "));
  return match ? match[1].toLowerCase() : "";
}

function rawText(el: Element): string {
  let out = "";
  for (const child of el.children) {
    if (isText(child)) {
      out += child.data;
    } else if (isElement(child)) {
      out += child.name.toLowerCase() === "br" ? "\n" : rawText(child);
    }
  }
  return out;
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
    ...(meta('meta[name="author"]')
      ? { author: meta('meta[name="author"]') }
      : {}),
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
