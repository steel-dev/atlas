import { jsonSchema } from "ai";
import {
  researchTool,
  type ResearchTool,
  type ToolContext,
} from "../custom-tools.js";
import { errorMessage } from "../errors.js";
import {
  buildContent,
  clampLimit,
  collapse,
  fetchJson,
  manifest,
} from "./shared.js";

export interface ClinicalTrialsOptions {
  defaultLimit?: number;
  status?: string[];
}

const ENDPOINT = "https://clinicaltrials.gov/api/v2/studies";

export function clinicaltrials(
  opts: ClinicalTrialsOptions = {},
): ResearchTool {
  const defaultLimit = clampLimit(opts.defaultLimit ?? 5);
  const status = (opts.status ?? [])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return researchTool({
    description:
      "Search ClinicalTrials.gov, the registry of clinical studies conducted around the world. Returns trial summaries (status, conditions, interventions, sponsor) as cited sources — including ongoing and unpublished trials not yet in the literature.",
    inputSchema: jsonSchema<{ query: string }>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query (condition, intervention, sponsor, or free text)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    async execute(input, ctx) {
      const query = String(input.query ?? "").trim();
      if (!query) return "clinicaltrials: empty query";
      const params = new URLSearchParams({
        "query.term": query,
        pageSize: String(defaultLimit),
        format: "json",
      });
      if (status.length) params.set("filter.overallStatus", status.join(","));
      let data: unknown;
      try {
        data = await fetchJson(`${ENDPOINT}?${params.toString()}`, ctx.signal);
      } catch (err) {
        return `clinicaltrials: request failed: ${errorMessage(err)}`;
      }
      return manifest("clinicaltrials", query, ingest(data, ctx));
    },
  });
}

function ingest(data: unknown, ctx: ToolContext): string[] {
  const studies =
    data && typeof data === "object"
      ? (data as { studies?: unknown }).studies
      : undefined;
  if (!Array.isArray(studies)) return [];
  const titles: string[] = [];
  for (const study of studies) {
    const p =
      ((study ?? {}) as { protocolSection?: Record<string, any> })
        .protocolSection ?? {};
    const idm = p.identificationModule ?? {};
    const nctId = collapse(String(idm.nctId ?? ""));
    const title = collapse(String(idm.briefTitle ?? idm.officialTitle ?? ""));
    if (!nctId || !title) continue;
    const overallStatus = collapse(
      String(p.statusModule?.overallStatus ?? ""),
    ).replace(/_/g, " ");
    const sponsor = collapse(
      String(p.sponsorCollaboratorsModule?.leadSponsor?.name ?? ""),
    );
    const conditions = list(p.conditionsModule?.conditions);
    const interventions = Array.isArray(p.armsInterventionsModule?.interventions)
      ? p.armsInterventionsModule.interventions
          .map((i: any) => collapse(String(i?.name ?? "")))
          .filter(Boolean)
          .slice(0, 8)
      : [];
    const studyType = collapse(String(p.designModule?.studyType ?? ""));
    const phases = list(p.designModule?.phases).map((x) =>
      x.replace(/_/g, " "),
    );
    const enrollment = p.designModule?.enrollmentInfo?.count;
    const abstract = collapse(String(p.descriptionModule?.briefSummary ?? ""));
    const typeLine = [studyType, phases.join("/")].filter(Boolean).join(" · ");
    const meta: string[] = [];
    if (overallStatus) meta.push(`Status: ${overallStatus}`);
    if (typeLine) meta.push(typeLine);
    if (conditions.length) meta.push(`Conditions: ${conditions.join(", ")}`);
    if (interventions.length)
      meta.push(`Interventions: ${interventions.join(", ")}`);
    if (sponsor) meta.push(`Sponsor: ${sponsor}`);
    if (typeof enrollment === "number") meta.push(`Enrollment: ${enrollment}`);
    ctx.addSource({
      url: `https://clinicaltrials.gov/study/${nctId}`,
      title,
      content: buildContent({ title, meta, abstract }),
    });
    titles.push(title);
  }
  return titles;
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => collapse(String(v))).filter(Boolean).slice(0, 8)
    : [];
}
