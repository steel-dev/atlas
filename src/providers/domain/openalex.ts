import { errorMessage } from "../../errors.js";
import { readEnv } from "../../env.js";
import {
  safeDomain,
  type SearchProvider,
  type SearchResult,
} from "../search.js";
import { buildContent, clampLimit, collapse, fetchJson } from "./shared.js";

export interface OpenAlexOptions {
  defaultLimit?: number;
  sort?: "relevance" | "date" | "citations";
  email?: string;
}

const ENDPOINT = "https://api.openalex.org/works";

export function openalex(opts: OpenAlexOptions = {}): SearchProvider {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const email = opts.email ?? readEnv("ATLAS_OPENALEX_EMAIL");
  const sort =
    opts.sort === "date"
      ? "publication_date:desc"
      : opts.sort === "citations"
        ? "cited_by_count:desc"
        : undefined;
  return {
    id: "openalex",
    async search({ query, maxResults, signal }) {
      const q = query.trim();
      if (!q) return [];
      const params = new URLSearchParams({
        search: q,
        per_page: String(clampLimit(maxResults ?? defaultLimit)),
      });
      if (sort) params.set("sort", sort);
      if (email) params.set("mailto", email);
      let data: unknown;
      try {
        data = await fetchJson(`${ENDPOINT}?${params.toString()}`, signal);
      } catch (err) {
        throw new Error(`openalex: request failed: ${errorMessage(err)}`);
      }
      return toResults(data);
    },
  };
}

function toResults(data: unknown): SearchResult[] {
  const results =
    data && typeof data === "object"
      ? (data as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
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
    out.push({
      position: out.length + 1,
      title,
      url,
      snippet: collapse([meta.join(" · "), abstract].filter(Boolean).join(" — ")),
      domain: safeDomain(url),
      meta: {
        openUrls: openAccessUrls(w),
        fallbackText: buildContent({ title, authors, meta, abstract }),
      },
    });
  }
  return out;
}

function openAccessUrls(w: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === "string" && /^https?:\/\//.test(u)) out.push(u);
  };
  const best = w.best_oa_location as Record<string, unknown> | undefined;
  push(best?.pdf_url);
  push(best?.landing_page_url);
  push((w.open_access as Record<string, unknown> | undefined)?.oa_url);
  const locs = w.oa_locations;
  if (Array.isArray(locs)) {
    for (const loc of locs) {
      const l = loc as Record<string, unknown>;
      push(l?.pdf_url);
      push(l?.landing_page_url);
    }
  }
  return out;
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
