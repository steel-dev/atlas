import * as cheerio from "cheerio";
import { errorMessage } from "../../errors.js";
import { readEnv } from "../../env.js";
import {
  safeDomain,
  type SearchProvider,
  type SearchResult,
} from "../search.js";
import { buildContent, clampLimit, collapse, fetchJson, fetchText } from "./shared.js";

export interface PubmedOptions {
  defaultLimit?: number;
  sort?: "relevance" | "date";
  apiKey?: string;
  email?: string;
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export function pubmed(opts: PubmedOptions = {}): SearchProvider {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const sort = opts.sort === "date" ? "pub_date" : "relevance";
  const apiKey = opts.apiKey ?? readEnv("ATLAS_NCBI_API_KEY");
  const email = opts.email ?? readEnv("ATLAS_NCBI_EMAIL");
  const common = (): Record<string, string> => {
    const p: Record<string, string> = { tool: "atlas" };
    if (email) p.email = email;
    if (apiKey) p.api_key = apiKey;
    return p;
  };
  return {
    id: "pubmed",
    async search({ query, maxResults, signal }) {
      const q = query.trim();
      if (!q) return [];
      const limit = clampLimit(maxResults ?? defaultLimit);
      let ids: string[];
      try {
        const params = new URLSearchParams({
          db: "pubmed",
          term: q,
          retmode: "json",
          retmax: String(limit),
          sort,
          ...common(),
        });
        const data = await fetchJson(
          `${EUTILS}/esearch.fcgi?${params.toString()}`,
          signal,
        );
        ids = extractIds(data);
      } catch (err) {
        throw new Error(`pubmed: search failed: ${errorMessage(err)}`);
      }
      if (ids.length === 0) return [];
      let xml: string;
      try {
        const params = new URLSearchParams({
          db: "pubmed",
          id: ids.join(","),
          rettype: "abstract",
          retmode: "xml",
          ...common(),
        });
        xml = await fetchText(
          `${EUTILS}/efetch.fcgi?${params.toString()}`,
          signal,
          "application/xml",
        );
      } catch (err) {
        throw new Error(`pubmed: fetch failed: ${errorMessage(err)}`);
      }
      return toResults(xml);
    },
  };
}

function extractIds(data: unknown): string[] {
  const idlist =
    data && typeof data === "object"
      ? (data as { esearchresult?: { idlist?: unknown } }).esearchresult?.idlist
      : undefined;
  return Array.isArray(idlist)
    ? idlist.filter((x): x is string => typeof x === "string")
    : [];
}

function toResults(xml: string): SearchResult[] {
  const $ = cheerio.load(xml, { xml: true });
  const out: SearchResult[] = [];
  $("PubmedArticle").each((_, el) => {
    const art = $(el);
    const pmid = art.find("MedlineCitation > PMID").first().text().trim();
    const title = collapse(art.find("ArticleTitle").first().text());
    if (!pmid || !title) return;
    const abstract = art
      .find("Abstract > AbstractText")
      .map((_, t) => {
        const label = $(t).attr("Label");
        const text = collapse($(t).text());
        return label && text ? `${label}: ${text}` : text;
      })
      .get()
      .filter(Boolean)
      .join("\n");
    const authors = art
      .find("AuthorList > Author")
      .map((_, a) => {
        const last = collapse($(a).find("LastName").first().text());
        const fore = collapse($(a).find("ForeName").first().text());
        return [fore, last].filter(Boolean).join(" ");
      })
      .get()
      .filter(Boolean)
      .slice(0, 12);
    const journal = collapse(art.find("Journal > Title").first().text());
    const year =
      art.find("PubDate > Year").first().text().trim() ||
      art.find("PubDate > MedlineDate").first().text().trim().slice(0, 4);
    const venue = journal && year ? `${journal} (${year})` : journal;
    const url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
    out.push({
      position: out.length + 1,
      title,
      url,
      snippet: collapse([venue, abstract].filter(Boolean).join(" — ")),
      domain: safeDomain(url),
      meta: {
        openUrls: [],
        fallbackText: buildContent({
          title,
          authors,
          meta: venue ? [venue] : [],
          abstract,
        }),
      },
    });
  });
  return out;
}
