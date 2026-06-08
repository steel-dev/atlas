import { jsonSchema } from "ai";
import {
  researchTool,
  type ResearchTool,
  type ToolContext,
} from "../custom-tools.js";
import { errorMessage } from "../errors.js";
import { readEnv } from "../env.js";
import {
  buildContent,
  clampLimit,
  collapse,
  fetchJson,
  manifest,
} from "./shared.js";

export interface OpenAlexOptions {
  defaultLimit?: number;
  sort?: "relevance" | "date" | "citations";
  email?: string;
}

const ENDPOINT = "https://api.openalex.org/works";

export function openalex(opts: OpenAlexOptions = {}): ResearchTool {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const email = opts.email ?? readEnv("ATLAS_OPENALEX_EMAIL");
  const sort =
    opts.sort === "date"
      ? "publication_date:desc"
      : opts.sort === "citations"
        ? "cited_by_count:desc"
        : undefined;
  return researchTool({
    description:
      "Search OpenAlex, an open index of scholarly works across all disciplines including the social sciences and humanities. Returns paper abstracts and metadata as cited sources.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "openalex: empty query";
      const params = new URLSearchParams({
        search: query,
        per_page: String(defaultLimit),
      });
      if (sort) params.set("sort", sort);
      if (email) params.set("mailto", email);
      let data: unknown;
      try {
        data = await fetchJson(`${ENDPOINT}?${params.toString()}`, ctx.signal);
      } catch (err) {
        return `openalex: request failed: ${errorMessage(err)}`;
      }
      return manifest("openalex", query, ingest(data, ctx));
    },
  });
}

function ingest(data: unknown, ctx: ToolContext): string[] {
  const results =
    data && typeof data === "object"
      ? (data as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(results)) return [];
  const titles: string[] = [];
  for (const row of results) {
    const w = (row ?? {}) as Record<string, unknown>;
    const title = collapse(String(w.title ?? w.display_name ?? ""));
    const url = workUrl(w);
    if (!title || !url) continue;
    const abstract = reconstructAbstract(w.abstract_inverted_index);
    const authors = Array.isArray(w.authorships)
      ? w.authorships
          .map((a) => collapse(String((a as any)?.author?.display_name ?? "")))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    const venue = collapse(
      String((w.primary_location as any)?.source?.display_name ?? ""),
    );
    const year = w.publication_year ? String(w.publication_year) : "";
    const meta: string[] = [];
    if (venue && year) meta.push(`${venue} (${year})`);
    else if (venue) meta.push(venue);
    else if (year) meta.push(`(${year})`);
    if (typeof w.cited_by_count === "number")
      meta.push(`Cited by ${w.cited_by_count}`);
    ctx.addSource({
      url,
      title,
      content: buildContent({ title, authors, meta, abstract }),
    });
    titles.push(title);
  }
  return titles;
}

function workUrl(w: Record<string, unknown>): string {
  const doi = typeof w.doi === "string" ? w.doi : "";
  if (doi)
    return /^https?:\/\//.test(doi)
      ? doi
      : `https://doi.org/${doi.replace(/^doi:/, "")}`;
  const landing = (w.primary_location as any)?.landing_page_url;
  if (typeof landing === "string" && /^https?:\/\//.test(landing)) return landing;
  const id = w.id;
  return typeof id === "string" && /^https?:\/\//.test(id) ? id : "";
}

function reconstructAbstract(inv: unknown): string {
  if (!inv || typeof inv !== "object") return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inv as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (typeof p === "number") slots[p] = word;
  }
  return collapse(slots.filter((s) => typeof s === "string").join(" "));
}
