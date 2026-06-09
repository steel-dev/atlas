import { jsonSchema } from "ai";
import {
  researchTool,
  type ResearchTool,
  type ToolContext,
} from "../custom-tools.js";
import { errorMessage } from "../errors.js";
import { readEnv } from "../env.js";
import { USER_AGENT, buildContent, clampLimit, collapse, manifest } from "./shared.js";

export interface SemanticScholarOptions {
  defaultLimit?: number;
  apiKey?: string;
}

const ENDPOINT = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS =
  "title,abstract,authors,year,venue,citationCount,tldr,externalIds,url";
const RATE_LIMITED = "rate-limited";

export function semanticScholar(
  opts: SemanticScholarOptions = {},
): ResearchTool {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const apiKey = opts.apiKey ?? readEnv("ATLAS_S2_API_KEY");
  return researchTool({
    description:
      "Search Semantic Scholar, an AI-powered index of scientific papers across all fields. Returns abstracts, one-line TL;DR summaries and citation counts as cited sources.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "semantic-scholar: empty query";
      const params = new URLSearchParams({
        query,
        limit: String(defaultLimit),
        fields: FIELDS,
      });
      let data: unknown;
      try {
        data = await search(`${ENDPOINT}?${params.toString()}`, apiKey, ctx.signal);
      } catch (err) {
        const message = errorMessage(err);
        if (message === RATE_LIMITED)
          return "semantic-scholar: rate limited — set ATLAS_S2_API_KEY (or pass { apiKey }) for higher limits.";
        return `semantic-scholar: request failed: ${message}`;
      }
      return manifest("semantic-scholar", query, ingest(data, ctx));
    },
  });
}

async function search(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  const resp = await fetch(url, { signal, headers });
  if (resp.status === 429) throw new Error(RATE_LIMITED);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());
  return resp.json();
}

function ingest(data: unknown, ctx: ToolContext): string[] {
  const rows =
    data && typeof data === "object"
      ? (data as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(rows)) return [];
  const titles: string[] = [];
  for (const row of rows) {
    const p = (row ?? {}) as Record<string, any>;
    const title = collapse(String(p.title ?? ""));
    const url = paperUrl(p);
    if (!title || !url) continue;
    const authors = Array.isArray(p.authors)
      ? p.authors
          .map((a: any) => collapse(String(a?.name ?? "")))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const venue = collapse(String(p.venue ?? ""));
    const year = p.year ? String(p.year) : "";
    const tldr = collapse(String(p.tldr?.text ?? ""));
    const abstract = collapse(String(p.abstract ?? ""));
    const meta: string[] = [];
    if (venue && year) meta.push(`${venue} (${year})`);
    else if (venue) meta.push(venue);
    else if (year) meta.push(`(${year})`);
    if (typeof p.citationCount === "number")
      meta.push(`Cited by ${p.citationCount}`);
    if (tldr) meta.push(`TL;DR: ${tldr}`);
    ctx.addSource({
      url,
      title,
      content: buildContent({ title, authors, meta, abstract }),
    });
    titles.push(title);
  }
  return titles;
}

function paperUrl(p: Record<string, any>): string {
  const doi = p.externalIds?.DOI;
  if (typeof doi === "string" && doi.trim())
    return `https://doi.org/${doi.replace(/^doi:/i, "").trim()}`;
  if (typeof p.url === "string" && /^https?:\/\//.test(p.url)) return p.url;
  const id = p.paperId;
  return typeof id === "string" && id
    ? `https://www.semanticscholar.org/paper/${id}`
    : "";
}
