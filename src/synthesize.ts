import type { ModelStepInput, ModelStepResult } from "./model.js";
import { type ResearchCtx } from "./runtime.js";
import { withRole } from "./recording.js";
import type { ResearchClaim } from "./claims.js";
import { voteSplit, type VerifySummary } from "./verify.js";

const REPORT_PROSE_MAX_TOKENS = 8_192;

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
      .map((claim) => `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)})`)
      .join("\n")
  );
}

const SYNTHESIS_SYSTEM_PROMPT =
  "You answer one research question from a set of source-cited claims, writing the final report directly as Markdown. " +
  "Prefer adversarially verified (confirmed) claims; you may fall back to an unconfirmed candidate when no confirmed claim answers, but flag such an answer as low confidence and say why. " +
  "Never use a refuted claim except to note it was ruled out; never invent claims or sources; carry each statement's source URL. " +
  "Lead with the direct answer in the very first sentence. " +
  "Match length to the question: a single fact deserves 1-3 sentences with no headings; a broad question earns proportionally more, but never pad or fill sections. " +
  "Calibrate certainty to the evidence: state a well-confirmed answer plainly; lightly qualify a thin one; for an answer resting on unconfirmed or weak sources, still lead with the best candidate but explicitly flag that it is unverified and why. " +
  "Cite each factual statement inline as a Markdown link to its source URL, using only URLs present in the claims. " +
  "Surface a caveat only where it changes how the answer should be read, inline next to the point it qualifies. " +
  "Do not add generic 'Caveats' or 'Open Questions' sections.";

export function synthesisPrompt(opts: {
  question: string;
  confirmed: ResearchClaim[];
  candidates: ResearchClaim[];
  refuted: ResearchClaim[];
  gapsNote?: string;
}): string {
  return (
    "## Answer the question\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${opts.confirmed.length} claim(s) survived adversarial verification` +
    (opts.candidates.length > 0
      ? `; ${opts.candidates.length} more were extracted but not verified`
      : "") +
    ". Merge duplicates and write the report.\n\n" +
    "## Confirmed claims\n" +
    (opts.confirmed.length > 0
      ? renderConfirmedClaims(opts.confirmed)
      : "(none)\n") +
    renderCandidateClaims(opts.candidates) +
    renderRefutedClaims(opts.refuted) +
    (opts.gapsNote ? `\n## Known gaps\n${opts.gapsNote}\n` : "") +
    "\n## Write the report\n" +
    "Merge claims that say the same thing and combine their sources. " +
    "Lead with the direct answer in the first sentence, then the supporting detail. " +
    "Prefer confirmed claims; if they do not answer, you may answer from the single best-supported candidate and flag it low confidence, never from a refuted claim, never invented. " +
    "Scale length to the question — a single fact is 1-3 sentences with no headings; a broad question gets more, never padded. " +
    "Cite facts inline as Markdown links using only the source URLs above. " +
    "Render the report as Markdown for the user."
  );
}

export async function synthesizeReport(
  ctx: ResearchCtx,
  opts: {
    question: string;
    confirmed: ResearchClaim[];
    candidates: ResearchClaim[];
    refuted: ResearchClaim[];
    gapsNote?: string;
  },
): Promise<string> {
  const input: ModelStepInput = {
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: synthesisPrompt(opts) }],
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
        (claim) => `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)})`,
      ),
    );
  }
  return lines.join("\n");
}

export function fallbackReportFromClaims(opts: {
  question: string;
  confirmed: ResearchClaim[];
  candidates: ResearchClaim[];
  refuted?: ResearchClaim[];
  gapsNote?: string;
}): string {
  const { question, confirmed, candidates, refuted = [], gapsNote } = opts;
  const finding = (claim: ResearchClaim): string =>
    `- ${claim.text} — [${claim.title || claim.url}](${claim.url}) (vote ${voteSplit(claim)}, "${claim.quote}")`;
  const lines: string[] = [
    `# Findings`,
    "",
    `**Question:** ${question}`,
    "",
    "Model synthesis did not complete; the verified material below is reported unmerged, grouped by how strongly it held up.",
  ];
  if (confirmed.length > 0) {
    lines.push(
      "",
      `## Verified findings (${confirmed.length})`,
      ...confirmed.map(finding),
    );
  }
  if (candidates.length > 0) {
    lines.push(
      "",
      `## Unrefuted but unverified (${candidates.length}) — treat as low confidence`,
      ...candidates.map(finding),
    );
  }
  if (gapsNote) {
    lines.push("", "## Gap assessment", gapsNote);
  }
  if (refuted.length > 0) {
    lines.push(
      "",
      `## Ruled out (${refuted.length})`,
      ...refuted.map(
        (claim) => `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)})`,
      ),
    );
  }
  return lines.join("\n");
}
