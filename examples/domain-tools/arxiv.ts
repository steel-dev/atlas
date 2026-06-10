import * as cheerio from "cheerio";
import { jsonSchema } from "ai";
import {
  researchTool,
  type ResearchTool,
  type ToolContext,
} from "../../src/custom-tools.js";
import { errorMessage } from "../../src/errors.js";
import {
  buildContent,
  clampLimit,
  collapse,
  fetchText,
  manifest,
} from "./shared.js";

export interface ArxivOptions {
  defaultLimit?: number;
  sort?: "relevance" | "lastUpdated" | "submitted";
}

const ENDPOINT = "https://export.arxiv.org/api/query";
const SORT: Record<string, string> = {
  relevance: "relevance",
  lastUpdated: "lastUpdatedDate",
  submitted: "submittedDate",
};

export function arxiv(opts: ArxivOptions = {}): ResearchTool {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const sortBy = SORT[opts.sort ?? "relevance"] ?? "relevance";
  return researchTool({
    description:
      "Search arXiv for preprints in physics, mathematics, computer science, quantitative biology, statistics, economics and related fields. Returns paper abstracts as cited sources.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "arxiv: empty query";
      const params = new URLSearchParams({
        search_query: `all:${query}`,
        start: "0",
        max_results: String(defaultLimit),
        sortBy,
        sortOrder: "descending",
      });
      let xml: string;
      try {
        xml = await fetchText(
          `${ENDPOINT}?${params.toString()}`,
          ctx.signal,
          "application/atom+xml",
        );
      } catch (err) {
        return `arxiv: request failed: ${errorMessage(err)}`;
      }
      return manifest("arxiv", query, ingest(xml, ctx));
    },
  });
}

function ingest(xml: string, ctx: ToolContext): string[] {
  const $ = cheerio.load(xml, { xml: true });
  const titles: string[] = [];
  $("entry").each((_, el) => {
    const entry = $(el);
    const title = collapse(entry.children("title").first().text());
    const url = entry
      .children("id")
      .first()
      .text()
      .trim()
      .replace(/^http:\/\//, "https://");
    if (!title || !url) return;
    const abstract = collapse(entry.children("summary").first().text());
    const authors = entry
      .find("author > name")
      .map((_, n) => collapse($(n).text()))
      .get()
      .filter(Boolean);
    const published = entry
      .children("published")
      .first()
      .text()
      .trim()
      .slice(0, 10);
    ctx.addSource({
      url,
      title,
      content: buildContent({
        title,
        authors,
        meta: published ? [`Published: ${published}`] : [],
        abstract,
      }),
    });
    titles.push(title);
  });
  return titles;
}
