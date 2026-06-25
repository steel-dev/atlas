import { jsonSchema } from "ai";
import {
  type ResearchTool,
  researchTool,
  type ToolContext,
} from "../../custom-tools.js";
import { errorMessage } from "../../errors.js";
import {
  buildContent,
  clampLimit,
  collapse,
  fetchJson,
  manifest,
} from "./shared.js";

export interface WikipediaOptions {
  defaultLimit?: number;
  lang?: string;
}

export function wikipedia(opts: WikipediaOptions = {}): ResearchTool {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 3, 10);
  const lang = (opts.lang ?? "en").toLowerCase();
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  return researchTool({
    description:
      "Search Wikipedia for encyclopedic background on people, places, organizations, concepts, and events. Returns article introductions as cited sources.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "wikipedia: empty query";
      const params = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: query,
        gsrlimit: String(defaultLimit),
        prop: "extracts",
        exintro: "1",
        explaintext: "1",
        format: "json",
        formatversion: "2",
      });
      let data: unknown;
      try {
        data = await fetchJson(`${api}?${params.toString()}`, ctx.signal);
      } catch (err) {
        return `wikipedia: request failed: ${errorMessage(err)}`;
      }
      return manifest("wikipedia", query, ingest(data, lang, ctx));
    },
  });
}

function ingest(data: unknown, lang: string, ctx: ToolContext): string[] {
  const pages =
    data && typeof data === "object"
      ? (data as { query?: { pages?: unknown } }).query?.pages
      : undefined;
  if (!Array.isArray(pages)) return [];
  const rows = pages
    .map((p) => {
      const rec = (p ?? {}) as Record<string, unknown>;
      return {
        title: String(rec.title ?? ""),
        extract: collapse(String(rec.extract ?? "")),
        index: typeof rec.index === "number" ? rec.index : 0,
      };
    })
    .filter((p) => p.title && p.extract)
    .sort((a, b) => a.index - b.index);
  const titles: string[] = [];
  for (const row of rows) {
    const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
      row.title.replace(/ /g, "_"),
    )}`;
    ctx.addSource({
      url,
      title: row.title,
      content: buildContent({ title: row.title, abstract: row.extract }),
    });
    titles.push(row.title);
  }
  return titles;
}
