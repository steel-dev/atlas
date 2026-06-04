import type {
  ModelOutputSchema,
  ModelStepInput,
  ModelStepResult,
} from "./model.js";
import { tokenBudgetExhaustedReason, type ResearchCtx } from "./runtime.js";
import type { ResearchClaim } from "./claims.js";
import { voteSplit, type VerifySummary } from "./verify.js";

const SYNTHESIS_MAX_TOKENS = 8_192;

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

export function renderConfirmedClaims(confirmed: ResearchClaim[]): string {
  return confirmed
    .map((claim, index) => {
      const supporting = claim.votes
        .filter((vote) => !vote.refuted)
        .sort(
          (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
        )[0];
      return (
        `### [${index}] ${claim.text}\n` +
        `Vote: ${voteSplit(claim)} · Source: ${claim.url} (${claim.sourceQuality}` +
        `${claim.publishedTime ? `, published ${claim.publishedTime}` : ""})\n` +
        `Quote: "${claim.quote}"\n` +
        (claim.corroboration && claim.corroboration > 1
          ? `Corroborated by ${claim.corroboration} independent sources` +
            (claim.corroboratingSources && claim.corroboratingSources.length > 0
              ? `: ${claim.corroboratingSources.join(", ")}`
              : "") +
            "\n"
          : "") +
        (supporting
          ? `Verifier evidence (${supporting.confidence}): ${supporting.evidence}\n`
          : "")
      );
    })
    .join("\n");
}

export function renderRefutedClaims(refuted: ResearchClaim[]): string {
  if (refuted.length === 0) return "";
  return (
    "\n## Refuted claims (do NOT use these in the report except to note they were ruled out)\n" +
    refuted
      .map(
        (claim) =>
          `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)})`,
      )
      .join("\n")
  );
}

const SYNTHESIS_SYSTEM_PROMPT =
  "You write the final cited research report from adversarially verified claims. " +
  "Every factual statement must be traceable to a confirmed claim below, cited inline with the source URL as a Markdown link. " +
  "Never cite a source that is not attached to a confirmed claim, and never resurrect a refuted claim.";

export function synthesisPrompt(opts: {
  question: string;
  confirmed: ResearchClaim[];
  refuted: ResearchClaim[];
  gapsNote?: string;
}): string {
  return (
    "## Synthesis: research report\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${opts.confirmed.length} claims survived adversarial verification. Merge semantic duplicates and synthesize.\n\n` +
    "## Confirmed claims\n" +
    renderConfirmedClaims(opts.confirmed) +
    renderRefutedClaims(opts.refuted) +
    (opts.gapsNote ? `\n## Known gaps\n${opts.gapsNote}\n` : "") +
    "\n## Instructions\n" +
    "1. Merge claims that say the same thing; combine their sources.\n" +
    "2. Group related claims into coherent findings that directly address the research question.\n" +
    "3. Weight findings by confidence: unanimous votes on primary sources are strong; claims corroborated by multiple independent sources are stronger still; split votes, single-source, or blog-quality claims are weaker — say so.\n" +
    "4. Open with a short executive summary that answers the research question.\n" +
    "5. Note caveats: what is uncertain, which sources were weak, what is time-sensitive.\n" +
    "6. Close with open questions that emerged but were not answered.\n" +
    "7. Cite every claim inline with its source URL as a Markdown link. Cite only the URLs listed above.\n\n" +
    "Write the report as Markdown."
  );
}

export function inconclusiveReport(opts: {
  question: string;
  verify: VerifySummary;
  refuted: ResearchClaim[];
  sourcesFetched: number;
  claimsUnsupported: number;
  gapsNote: string;
}): string {
  const lines = [
    `# Research inconclusive`,
    "",
    `**Question:** ${opts.question}`,
    "",
    `No claims survived adversarial verification. ${opts.sourcesFetched} source${opts.sourcesFetched === 1 ? "" : "s"} fetched, ${opts.verify.verified} claim${opts.verify.verified === 1 ? "" : "s"} verified, ${opts.verify.refuted} refuted, ${opts.verify.unverified} unverified${opts.claimsUnsupported > 0 ? `, ${opts.claimsUnsupported} dropped for unsupported quotes` : ""}.`,
  ];
  if (opts.gapsNote) {
    lines.push("", "## Gap assessment", opts.gapsNote);
  }
  if (opts.refuted.length > 0) {
    lines.push(
      "",
      "## Refuted claims",
      ...opts.refuted.map(
        (claim) =>
          `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)})`,
      ),
    );
  }
  return lines.join("\n");
}

export function fallbackReportFromClaims(
  question: string,
  confirmed: ResearchClaim[],
): string {
  return [
    `# Verified findings (synthesis unavailable)`,
    "",
    `**Question:** ${question}`,
    "",
    `Synthesis failed or returned nothing; the ${confirmed.length} adversarially verified claim${confirmed.length === 1 ? "" : "s"} below are reported unmerged.`,
    "",
    ...confirmed.map(
      (claim) =>
        `- ${claim.text} — [${claim.title || claim.url}](${claim.url}) (vote ${voteSplit(claim)}, "${claim.quote}")`,
    ),
  ].join("\n");
}

export async function synthesizeReport(
  ctx: ResearchCtx,
  opts: {
    question: string;
    confirmed: ResearchClaim[];
    refuted: ResearchClaim[];
    gapsNote?: string;
  },
): Promise<string> {
  const input: ModelStepInput = {
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: synthesisPrompt(opts),
      },
    ],
    maxTokens: ctx.config.maxOutputTokens ?? SYNTHESIS_MAX_TOKENS,
    providerOptions: ctx.config.finalizeProviderOptions,
    signal: ctx.deps.signal,
  };
  const stepStream = ctx.deps.model.stepStream?.bind(ctx.deps.model);
  let result: ModelStepResult;
  if (stepStream) {
    result = await stepStream(input, {
      onStart: () => ctx.scope.emit({ type: "report_boundary" }),
      onText: (text) => ctx.scope.emit({ type: "report_delta", text }),
    });
  } else {
    result = await ctx.deps.model.step(input);
  }
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

export function extractOpenQuestions(markdown: string): string[] {
  const questions: string[] = [];
  let inSection = false;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      inSection = /open\s+questions?/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (item) questions.push(item[1].trim());
  }
  return questions;
}

export interface ReportStructure {
  caveats: string[];
  openQuestions: string[];
}

const REPORT_STRUCTURE_MAX_TOKENS = 800;
const REPORT_STRUCTURE_MAX_ITEMS = 8;

const REPORT_STRUCTURE_SCHEMA: ModelOutputSchema = {
  name: "report_structure",
  schema: {
    type: "object",
    required: ["caveats", "openQuestions"],
    properties: {
      caveats: {
        type: "array",
        maxItems: REPORT_STRUCTURE_MAX_ITEMS,
        items: { type: "string" },
      },
      openQuestions: {
        type: "array",
        maxItems: REPORT_STRUCTURE_MAX_ITEMS,
        items: { type: "string" },
      },
    },
  },
};

const REPORT_STRUCTURE_SYSTEM_PROMPT =
  "You extract two lists from a finished research report: the caveats it states and the open questions it raises. " +
  "Report only what the report itself states or directly implies — never invent caveats or questions. Structured output only.";

function reportStructurePrompt(markdown: string): string {
  return (
    "## Report\n" +
    markdown +
    "\n\n## Task\n" +
    "Read the report above and return two lists drawn strictly from it:\n" +
    "- caveats: limitations, uncertainties, weak or single sources, and time-sensitivity the report notes.\n" +
    "- openQuestions: questions the report raises or explicitly leaves unanswered.\n" +
    "Condense each to one sentence in the report's own terms. Return an empty list for either if the report states none. Add nothing the report does not support.\n\nStructured output only."
  );
}

interface RawReportStructure {
  caveats?: unknown;
  openQuestions?: unknown;
}

function readStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (items.length >= max) break;
  }
  return items;
}

export function parseReportStructure(text: string): ReportStructure | null {
  let raw: RawReportStructure;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    raw = parsed as RawReportStructure;
  } catch {
    return null;
  }
  return {
    caveats: readStringList(raw.caveats, REPORT_STRUCTURE_MAX_ITEMS),
    openQuestions: readStringList(raw.openQuestions, REPORT_STRUCTURE_MAX_ITEMS),
  };
}

export async function extractReportStructure(
  ctx: ResearchCtx,
  markdown: string,
): Promise<ReportStructure> {
  if (!markdown.trim()) return { caveats: [], openQuestions: [] };
  const fallback: ReportStructure = {
    caveats: [],
    openQuestions: extractOpenQuestions(markdown),
  };
  if (tokenBudgetExhaustedReason(ctx)) return fallback;
  const model = ctx.deps.leafModel ?? ctx.deps.model;
  try {
    const result = await model.step({
      system: REPORT_STRUCTURE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: reportStructurePrompt(markdown) }],
      maxTokens: REPORT_STRUCTURE_MAX_TOKENS,
      outputSchema: REPORT_STRUCTURE_SCHEMA,
      signal: ctx.deps.signal,
    });
    const textBlock = result.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    return parseReportStructure(textBlock?.text ?? "") ?? fallback;
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return fallback;
  }
}
