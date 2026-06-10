import { jsonSchema } from "ai";
import { researchTool, type ResearchTool } from "../../src/custom-tools.js";
import { errorMessage } from "../../src/errors.js";
import { readEnv } from "../../src/env.js";
import { clampLimit, collapse } from "./shared.js";

export interface EdgarOptions {
  defaultLimit?: number;
  forms?: string[];
  from?: string;
  to?: string;
  userAgent?: string;
  email?: string;
}

const ENDPOINT = "https://efts.sec.gov/LATEST/search-index";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";

interface Filing {
  label: string;
  url: string;
}

export function edgar(opts: EdgarOptions = {}): ResearchTool {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 10, 10);
  const forms = (opts.forms ?? []).map((f) => f.trim()).filter(Boolean);
  const email = opts.email ?? readEnv("ATLAS_SEC_EMAIL");
  const userAgent =
    opts.userAgent ??
    readEnv("ATLAS_SEC_USER_AGENT") ??
    (email ? `atlas-research/0.1 (${email})` : undefined);
  return researchTool({
    description:
      "Search SEC EDGAR full-text filings (10-K, 10-Q, 8-K, S-1 and other U.S. company disclosures since 2001). Returns matching filings with their filer, form type, date and URL — fetch a filing URL to ingest its full text as a citable source.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search query" },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "edgar: empty query";
      if (!userAgent)
        return "edgar: SEC requires a contact email in the User-Agent. Set ATLAS_SEC_EMAIL (or pass { email } / { userAgent }).";
      const params = new URLSearchParams({ q: query });
      if (forms.length) params.set("forms", forms.join(","));
      if (opts.from) params.set("startdt", opts.from);
      if (opts.to) params.set("enddt", opts.to);
      let data: unknown;
      try {
        data = await fetchEdgar(
          `${ENDPOINT}?${params.toString()}`,
          userAgent,
          ctx.signal,
        );
      } catch (err) {
        return `edgar: request failed: ${errorMessage(err)}`;
      }
      const filings = parse(data, defaultLimit);
      if (filings.length === 0) return `edgar: no results for "${query}"`;
      const list = filings.map((f) => `- ${f.label}: ${f.url}`).join("\n");
      return `edgar: found ${filings.length} filing(s) for "${query}"; fetch a URL to ingest its full text:\n${list}`;
    },
  });
}

async function fetchEdgar(
  url: string,
  userAgent: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const resp = await fetch(url, {
    signal,
    headers: { "user-agent": userAgent, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());
  return resp.json();
}

function parse(data: unknown, limit: number): Filing[] {
  const hits =
    data && typeof data === "object"
      ? (data as { hits?: { hits?: unknown } }).hits?.hits
      : undefined;
  if (!Array.isArray(hits)) return [];
  const filings: Filing[] = [];
  for (const hit of hits.slice(0, limit)) {
    const h = (hit ?? {}) as Record<string, unknown>;
    const src = (h._source ?? {}) as Record<string, any>;
    const id = String(h._id ?? "");
    const colon = id.indexOf(":");
    const accession = colon >= 0 ? id.slice(0, colon) : String(src.adsh ?? "");
    const filename = colon >= 0 ? id.slice(colon + 1) : "";
    const cik = String(src.ciks?.[0] ?? "").replace(/^0+/, "");
    if (!cik || !accession || !filename) continue;
    const url = `${ARCHIVES}/${cik}/${accession.replace(/-/g, "")}/${filename}`;
    const display = collapse(String(src.display_names?.[0] ?? ""));
    const company = display.split("(")[0].trim() || display || `CIK ${cik}`;
    const form = collapse(String(src.form ?? src.file_type ?? ""));
    const filed = collapse(String(src.file_date ?? ""));
    const period = collapse(String(src.period_ending ?? ""));
    const label = [
      company,
      form,
      filed && `filed ${filed}`,
      period && `period ${period}`,
    ]
      .filter(Boolean)
      .join(" · ");
    filings.push({ label, url });
  }
  return filings;
}
