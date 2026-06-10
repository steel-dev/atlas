import * as cheerio from "cheerio";
import { jsonSchema } from "ai";
import {
  researchTool,
  type ResearchTool,
  type ToolContext,
} from "../../src/custom-tools.js";
import { errorMessage } from "../../src/errors.js";
import { readEnv } from "../../src/env.js";
import {
  buildContent,
  clampLimit,
  collapse,
  fetchJson,
  fetchText,
  manifest,
} from "./shared.js";

export interface PubmedOptions {
  defaultLimit?: number;
  sort?: "relevance" | "date";
  apiKey?: string;
  email?: string;
}

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export function pubmed(opts: PubmedOptions = {}): ResearchTool {
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
  return researchTool({
    description:
      "Search PubMed (NCBI) for biomedical and life-sciences literature. Returns peer-reviewed article abstracts as cited sources.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "pubmed: empty query";
      let ids: string[];
      try {
        const params = new URLSearchParams({
          db: "pubmed",
          term: query,
          retmode: "json",
          retmax: String(defaultLimit),
          sort,
          ...common(),
        });
        const data = await fetchJson(
          `${EUTILS}/esearch.fcgi?${params.toString()}`,
          ctx.signal,
        );
        ids = extractIds(data);
      } catch (err) {
        return `pubmed: search failed: ${errorMessage(err)}`;
      }
      if (ids.length === 0) return `pubmed: no results for "${query}"`;
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
          ctx.signal,
          "application/xml",
        );
      } catch (err) {
        return `pubmed: fetch failed: ${errorMessage(err)}`;
      }
      return manifest("pubmed", query, ingest(xml, ctx));
    },
  });
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

function ingest(xml: string, ctx: ToolContext): string[] {
  const $ = cheerio.load(xml, { xml: true });
  const titles: string[] = [];
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
    ctx.addSource({
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      title,
      content: buildContent({
        title,
        authors,
        meta: venue ? [venue] : [],
        abstract,
      }),
    });
    titles.push(title);
  });
  return titles;
}
