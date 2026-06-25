import * as cheerio from "cheerio";
import { errorMessage } from "../../errors.js";
import {
  type SearchProvider,
  type SearchResult,
  safeDomain,
} from "../search.js";
import { buildContent, clampLimit, collapse, fetchText } from "./shared.js";

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

export function arxiv(opts: ArxivOptions = {}): SearchProvider {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const sortBy = SORT[opts.sort ?? "relevance"] ?? "relevance";
  return {
    id: "arxiv",
    async search({ query, maxResults, signal }) {
      const q = query.trim();
      if (!q) return [];
      const params = new URLSearchParams({
        search_query: `all:${q}`,
        start: "0",
        max_results: String(clampLimit(maxResults ?? defaultLimit)),
        sortBy,
        sortOrder: "descending",
      });
      let xml: string;
      try {
        xml = await fetchText(
          `${ENDPOINT}?${params.toString()}`,
          signal,
          "application/atom+xml",
        );
      } catch (err) {
        throw new Error(`arxiv: request failed: ${errorMessage(err)}`);
      }
      return toResults(xml);
    },
  };
}

function toResults(xml: string): SearchResult[] {
  const $ = cheerio.load(xml, { xml: true });
  const out: SearchResult[] = [];
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
    const meta = published ? [`Published: ${published}`] : [];
    out.push({
      position: out.length + 1,
      title,
      url,
      snippet: abstract,
      domain: safeDomain(url),
      meta: {
        openUrls: pdfUrls(url),
        fallbackText: buildContent({ title, authors, meta, abstract }),
      },
    });
  });
  return out;
}

function pdfUrls(absUrl: string): string[] {
  return absUrl.includes("/abs/")
    ? [absUrl.replace("/abs/", "/pdf/"), absUrl]
    : [absUrl];
}
