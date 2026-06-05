import type {
  ModelOutputSchema,
  ModelStepInput,
  ModelStepResult,
} from "./model.js";
import { type ResearchCtx } from "./runtime.js";
import { withRole } from "./recording.js";
import type { ClaimConfidence, ResearchClaim } from "./claims.js";
import { voteSplit, type VerifySummary } from "./verify.js";

const REPORT_DATA_MAX_TOKENS = 8_192;
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

export function renderCandidateClaims(candidates: ResearchClaim[]): string {
  if (candidates.length === 0) return "";
  return (
    "\n## Unconfirmed candidate claims (quote-grounded but NOT adversarially verified — use only as a fallback when no confirmed claim answers, and label them low confidence)\n" +
    candidates
      .map(
        (claim, index) =>
          `### (candidate ${index}) ${claim.text}\n` +
          `Source: ${claim.url} (${claim.sourceQuality}` +
          `${claim.publishedTime ? `, published ${claim.publishedTime}` : ""})\n` +
          `Quote: "${claim.quote}"\n`,
      )
      .join("\n")
  );
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
  answerConfidence: ClaimConfidence;
  findings: ReportFinding[];
  caveats: string[];
  openQuestions: string[];
}

const REPORT_DATA_SCHEMA: ModelOutputSchema = {
  name: "report_data",
  schema: {
    type: "object",
    required: ["answer", "answerConfidence", "findings"],
    properties: {
      answer: { type: "string" },
      answerConfidence: { type: "string", enum: [...CONFIDENCE_VALUES] },
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
  "You organize research claims into a structured answer to one research question. " +
  "Prefer adversarially verified (confirmed) claims; you may fall back to an unconfirmed candidate when no confirmed claim answers, but you must mark such an answer low confidence. " +
  "Never use a refuted claim except to note it was ruled out; never invent claims, caveats, or open questions; carry each statement's source URL. " +
  "Structured output only.";

export function reportDataPrompt(opts: {
  question: string;
  confirmed: ResearchClaim[];
  candidates: ResearchClaim[];
  refuted: ResearchClaim[];
  gapsNote?: string;
}): string {
  return (
    "## Organize the findings\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${opts.confirmed.length} claim(s) survived adversarial verification` +
    (opts.candidates.length > 0
      ? `; ${opts.candidates.length} more were extracted but not verified`
      : "") +
    ". Merge duplicates and structure the answer.\n\n" +
    "## Confirmed claims\n" +
    (opts.confirmed.length > 0
      ? renderConfirmedClaims(opts.confirmed)
      : "(none)\n") +
    renderCandidateClaims(opts.candidates) +
    renderRefutedClaims(opts.refuted) +
    (opts.gapsNote ? `\n## Known gaps\n${opts.gapsNote}\n` : "") +
    "\n## Instructions\n" +
    "1. Merge claims that say the same thing; combine their sources.\n" +
    "2. answer: prefer confirmed claims. If they answer the question, answer from them. If they do NOT, you MAY answer from the single best-supported candidate that plausibly fits — never from a refuted claim, and never invented. If nothing fits, state plainly that it could not be determined.\n" +
    "3. answerConfidence: high only when the answer rests on confirmed, corroborated, or primary sources; medium when confirmed but thin; low when it rests on an unconfirmed candidate or a single weak source.\n" +
    "4. findings: the supporting points, each with confidence and source URLs.\n" +
    "5. caveats: if the answer leans on an unconfirmed or weak source, add a caveat naming exactly that. Include other genuine limitations. Empty if none.\n" +
    "6. openQuestions: only what the known gaps actually leave unresolved. Empty if none. Never pad.\n\n" +
    "Structured output only."
  );
}

interface RawReportData {
  answer?: unknown;
  answerConfidence?: unknown;
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
        ? raw.sources.filter(
            (source): source is string => typeof source === "string",
          )
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
    answerConfidence: readConfidence(raw.answerConfidence),
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
    candidates: ResearchClaim[];
    refuted: ResearchClaim[];
    gapsNote?: string;
  },
): Promise<ReportData | null> {
  const result = await withRole("synthesis.data", () =>
    ctx.deps.model.step({
      system: REPORT_DATA_SYSTEM_PROMPT,
      messages: [{ role: "user", content: reportDataPrompt(opts) }],
      maxTokens: REPORT_DATA_MAX_TOKENS,
      outputSchema: REPORT_DATA_SCHEMA,
      providerOptions: ctx.config.finalizeProviderOptions,
      signal: ctx.deps.signal,
    }),
  );
  const textBlock = result.content.find(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  return parseReportData(textBlock?.text ?? "");
}

const REPORT_PROSE_SYSTEM_PROMPT =
  "You write the final answer to a research question from a structured, source-cited findings object. " +
  "Lead with the direct answer in the very first sentence. " +
  "Match length to the question: a single fact deserves 1-3 sentences with no headings; a broad question earns proportionally more, but never pad or fill sections. " +
  "Calibrate certainty to the stated answer confidence: state a high-confidence answer plainly; lightly qualify a medium one; for a low-confidence answer, still lead with the best candidate but explicitly flag that it is unverified or rests on a weak source, and why. " +
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
    `## Direct answer (confidence: ${data.answerConfidence})\n` +
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
    "Calibrate certainty to the confidence above: a low-confidence answer must still lead with the best candidate but openly flag that it is unverified or weakly sourced. " +
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
    result = await withRole("synthesis.prose", () =>
      stepStream(input, {
        onStart: () => ctx.scope.emit({ type: "report_boundary" }),
        onText: (text) => ctx.scope.emit({ type: "report_delta", text }),
      }),
    );
  } else {
    result = await withRole("synthesis.prose", () => ctx.deps.model.step(input));
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
