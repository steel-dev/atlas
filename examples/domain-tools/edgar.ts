import { errorMessage } from "../../src/errors.js";
import { readEnv } from "../../src/env.js";
import {
  safeDomain,
  type SearchProvider,
  type SearchResult,
} from "../../src/providers/search.js";
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

export function edgar(opts: EdgarOptions = {}): SearchProvider {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 10, 10);
  const forms = (opts.forms ?? []).map((f) => f.trim()).filter(Boolean);
  const email = opts.email ?? readEnv("ATLAS_SEC_EMAIL");
  const userAgent =
    opts.userAgent ??
    readEnv("ATLAS_SEC_USER_AGENT") ??
    (email ? `atlas-research/0.1 (${email})` : undefined);
  return {
    id: "edgar",
    async search({ query, maxResults, signal }) {
      const q = query.trim();
      if (!q) return [];
      if (!userAgent) {
        throw new Error(
          "edgar: SEC requires a contact email in the User-Agent; set ATLAS_SEC_EMAIL (or pass { email } / { userAgent }).",
        );
      }
      const params = new URLSearchParams({ q });
      if (forms.length) params.set("forms", forms.join(","));
      if (opts.from) params.set("startdt", opts.from);
      if (opts.to) params.set("enddt", opts.to);
      let data: unknown;
      try {
        data = await fetchEdgar(`${ENDPOINT}?${params.toString()}`, userAgent, signal);
      } catch (err) {
        throw new Error(`edgar: request failed: ${errorMessage(err)}`);
      }
      return parse(data, clampLimit(maxResults ?? defaultLimit, 10));
    },
  };
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

function parse(data: unknown, limit: number): SearchResult[] {
  const hits =
    data && typeof data === "object"
      ? (data as { hits?: { hits?: unknown } }).hits?.hits
      : undefined;
  if (!Array.isArray(hits)) return [];
  const out: SearchResult[] = [];
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
    out.push({
      position: out.length + 1,
      title: label,
      url,
      snippet: [form, filed && `filed ${filed}`, period && `period ${period}`]
        .filter(Boolean)
        .join(" · "),
      domain: safeDomain(url),
    });
  }
  return out;
}
