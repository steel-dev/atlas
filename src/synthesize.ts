import type {
  ModelOutputSchema,
  ModelStepInput,
  ModelStepResult,
} from "./model.js";
import { type ResearchCtx } from "./runtime.js";
import type { ClaimConfidence, ResearchClaim } from "./claims.js";
import { voteSplit, type VerifySummary } from "./verify.js";

const REPORT_DATA_MAX_TOKENS = 4_096;
const REPORT_PROSE_MAX_TOKENS = 8_192;
const REPORT_DATA_MAX_FINDINGS = 12;
const REPORT_DATA_MAX_ITEMS = 8;

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;
const CONFIDENCE_VALUES: readonly ClaimConfidence[] = ["high", "medium", "low"];

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

export interface ReportFinding {
  statement: string;
  confidence: ClaimConfidence;
  sources: string[];
}

export interface ReportData {
  answer: string;
  findings: ReportFinding[];
  caveats: string[];
  openQuestions: string[];
}

const REPORT_DATA_SCHEMA: ModelOutputSchema = {
  name: "report_data",
  schema: {
    type: "object",
    required: ["answer", "findings"],
    properties: {
      answer: { type: "string" },
      findings: {
        type: "array",
        maxItems: REPORT_DATA_MAX_FINDINGS,
        items: {
          type: "object",
          required: ["statement", "confidence"],
          properties: {
            statement: { type: "string" },
            confidence: { type: "string", enum: [...CONFIDENCE_VALUES] },
            sources: { type: "array", items: { type: "string" } },
          },
        },
      },
      caveats: {
        type: "array",
        maxItems: REPORT_DATA_MAX_ITEMS,
        items: { type: "string" },
      },
      openQuestions: {
        type: "array",
        maxItems: REPORT_DATA_MAX_ITEMS,
        items: { type: "string" },
      },
    },
  },
};

const REPORT_DATA_SYSTEM_PROMPT =
  "You organize adversarially verified claims into a structured answer to one research question. " +
  "Every statement must trace to a confirmed claim and carry its source URL; never use a refuted claim except to note it was ruled out; never invent caveats or open questions. " +
  "Structured output only.";

export function reportDataPrompt(opts: {
  question: string;
  confirmed: ResearchClaim[];
  refuted: ResearchClaim[];
  gapsNote?: string;
}): string {
  return (
    "## Organize the verified findings\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${opts.confirmed.length} claim(s) survived adversarial verification. Merge duplicates and structure the answer.\n\n` +
    "## Confirmed claims\n" +
    renderConfirmedClaims(opts.confirmed) +
    renderRefutedClaims(opts.refuted) +
    (opts.gapsNote ? `\n## Known gaps\n${opts.gapsNote}\n` : "") +
    "\n## Instructions\n" +
    "1. Merge claims that say the same thing; combine their sources.\n" +
    "2. answer: the most direct answer the confirmed claims support. If they do not answer the question, state plainly what they do establish — do not guess.\n" +
    "3. findings: the supporting points. Confidence is high for unanimous votes on primary or multiply-corroborated sources, low for split votes or a single weak source.\n" +
    "4. caveats: only genuine limitations — weak or single sources, staleness, unresolved conflicts. Empty if none.\n" +
    "5. openQuestions: only what the known gaps actually leave unresolved. Empty if none. Never pad.\n\n" +
    "Structured output only."
  );
}

interface RawReportData {
  answer?: unknown;
  findings?: unknown;
  caveats?: unknown;
  openQuestions?: unknown;
}

function readConfidence(raw: unknown): ClaimConfidence {
  return CONFIDENCE_VALUES.find((value) => value === raw) ?? "low";
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

function readFindings(value: unknown): ReportFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReportFinding[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as {
      statement?: unknown;
      confidence?: unknown;
      sources?: unknown;
    };
    const statement =
      typeof raw.statement === "string" ? raw.statement.trim() : "";
    if (!statement) continue;
    findings.push({
      statement,
      confidence: readConfidence(raw.confidence),
      sources: Array.isArray(raw.sources)
        ? raw.sources.filter((source): source is string => typeof source === "string")
        : [],
    });
    if (findings.length >= REPORT_DATA_MAX_FINDINGS) break;
  }
  return findings;
}

export function parseReportData(text: string): ReportData | null {
  let raw: RawReportData;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    raw = parsed as RawReportData;
  } catch {
    return null;
  }
  const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
  if (!answer) return null;
  return {
    answer,
    findings: readFindings(raw.findings),
    caveats: readStringList(raw.caveats, REPORT_DATA_MAX_ITEMS),
    openQuestions: readStringList(raw.openQuestions, REPORT_DATA_MAX_ITEMS),
  };
}

export async function synthesizeReportData(
  ctx: ResearchCtx,
  opts: {
    question: string;
    confirmed: ResearchClaim[];
    refuted: ResearchClaim[];
    gapsNote?: string;
  },
): Promise<ReportData | null> {
  const result = await ctx.deps.model.step({
    system: REPORT_DATA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: reportDataPrompt(opts) }],
    maxTokens: REPORT_DATA_MAX_TOKENS,
    outputSchema: REPORT_DATA_SCHEMA,
    providerOptions: ctx.config.finalizeProviderOptions,
    signal: ctx.deps.signal,
  });
  const textBlock = result.content.find(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  return parseReportData(textBlock?.text ?? "");
}

const REPORT_PROSE_SYSTEM_PROMPT =
  "You write the final answer to a research question from a structured, source-cited findings object. " +
  "Lead with the direct answer in the very first sentence. " +
  "Match length to the question: a single fact deserves 1-3 sentences with no headings; a broad question earns proportionally more, but never pad or pad out sections. " +
  "Cite each factual statement inline as a Markdown link to its source URL, using only URLs present in the findings. " +
  "Surface a caveat only where it changes how the answer should be read, inline next to the point it qualifies. " +
  "Never append generic 'Caveats' or 'Open Questions' sections.";

export function reportProsePrompt(question: string, data: ReportData): string {
  const findings =
    data.findings.length > 0
      ? data.findings
          .map(
            (finding, index) =>
              `${index + 1}. (${finding.confidence}) ${finding.statement}` +
              (finding.sources.length > 0
                ? ` [sources: ${finding.sources.join(", ")}]`
                : ""),
          )
          .join("\n")
      : "(none)";
  return (
    `**Question:** ${question}\n\n` +
    "## Direct answer (verified)\n" +
    data.answer +
    "\n\n## Supporting findings\n" +
    findings +
    "\n" +
    (data.caveats.length > 0
      ? "\n## Caveats you may weave in where they change how the answer reads\n" +
        data.caveats.map((caveat) => `- ${caveat}`).join("\n") +
        "\n"
      : "") +
    "\n## Write the report\n" +
    "Render the answer as Markdown for the user. Lead with the answer in the first sentence. " +
    "Scale length to the question — a single fact is 1-3 sentences with no headings; a broad question gets more, never padded. " +
    "Cite facts inline as Markdown links using only the source URLs listed above. " +
    "Weave in a caveat only where it changes how the answer should be read. Do not add 'Caveats' or 'Open Questions' sections."
  );
}

export async function writeReportProse(
  ctx: ResearchCtx,
  opts: { question: string; data: ReportData },
): Promise<string> {
  const input: ModelStepInput = {
    system: REPORT_PROSE_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: reportProsePrompt(opts.question, opts.data) },
    ],
    maxTokens: ctx.config.maxOutputTokens ?? REPORT_PROSE_MAX_TOKENS,
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
