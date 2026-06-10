import { streamText } from "ai";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { RunCtx } from "./state.js";
import { voteSplit } from "./verify.js";
import type { ResearchClaim } from "./ledger.js";

const REPORT_MAX_TOKENS = 8_192;
const SOURCE_CONTEXT_WINDOW = 500;
const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;
const CANDIDATE_IMPORTANCE_RANK = {
  central: 0,
  supporting: 1,
  tangential: 2,
} as const;
const CANDIDATE_QUALITY_RANK = {
  primary: 0,
  secondary: 1,
  blog: 2,
  forum: 3,
  unreliable: 4,
} as const;
const MAX_REPORT_CANDIDATES = 15;

export interface ClaimPartition {
  confirmed: ResearchClaim[];
  contested: ResearchClaim[];
  refuted: ResearchClaim[];
  candidates: ResearchClaim[];
}

export function partitionClaims(claims: ResearchClaim[]): ClaimPartition {
  const representatives = claims.filter((claim) => !claim.duplicateOf);
  const confirmed = representatives.filter(
    (claim) => claim.status === "confirmed",
  );
  const contested = representatives.filter(
    (claim) => claim.status === "contested",
  );
  const refuted = representatives.filter((claim) => claim.status === "refuted");
  const unverified = representatives.filter(
    (claim) => claim.status === "quoted" || claim.status === "unverified",
  );
  const candidates = unverified
    .slice()
    .sort(
      (a, b) =>
        CANDIDATE_IMPORTANCE_RANK[a.importance] -
          CANDIDATE_IMPORTANCE_RANK[b.importance] ||
        CANDIDATE_QUALITY_RANK[a.sourceQuality] -
          CANDIDATE_QUALITY_RANK[b.sourceQuality],
    )
    .slice(0, MAX_REPORT_CANDIDATES);
  return { confirmed, contested, refuted, candidates };
}

function quoteContext(rctx: RunCtx, claim: ResearchClaim): string | undefined {
  const doc = rctx.sources.byId.get(claim.sourceId);
  if (!doc) return undefined;
  const idx = doc.markdown.indexOf(claim.quote);
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - SOURCE_CONTEXT_WINDOW);
  const end = Math.min(
    doc.markdown.length,
    idx + claim.quote.length + SOURCE_CONTEXT_WINDOW,
  );
  return (
    (start > 0 ? "…" : "") +
    doc.markdown.slice(start, end) +
    (end < doc.markdown.length ? "…" : "")
  );
}

function renderClaimBlock(
  claim: ResearchClaim,
  context?: string | undefined,
): string {
  const supporting = claim.votes
    .filter((vote) => !vote.refuted)
    .sort(
      (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
    )[0];
  return (
    `### [${claim.id}] ${claim.text}\n` +
    `Vote: ${voteSplit(claim)} · Source: ${claim.url} (${claim.sourceQuality}` +
    `${claim.publishedTime ? `, published ${claim.publishedTime}` : ""})\n` +
    `Quote: "${claim.quote}"\n` +
    (context ? `Source context: ${context}\n` : "") +
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
}

export function renderConfirmedClaims(
  confirmed: ResearchClaim[],
  context?: (claim: ResearchClaim) => string | undefined,
): string {
  return confirmed
    .map((claim) => renderClaimBlock(claim, context?.(claim)))
    .join("\n");
}

function renderContestedClaims(contested: ResearchClaim[]): string {
  if (contested.length === 0) return "";
  return (
    "\n## Contested claims (one verifier refuted; report the disagreement, do not state these as settled fact)\n" +
    contested
      .map(
        (claim) =>
          `### [${claim.id}] ${claim.text}\n` +
          `Vote: ${voteSplit(claim)} · Source: ${claim.url}\n` +
          `Quote: "${claim.quote}"\n` +
          claim.votes
            .filter((vote) => vote.refuted)
            .map((vote) => `Refuting evidence (${vote.lens}): ${vote.evidence}`)
            .join("\n") +
          "\n",
      )
      .join("\n")
  );
}

function renderCandidateClaims(candidates: ResearchClaim[]): string {
  if (candidates.length === 0) return "";
  return (
    "\n## Unconfirmed candidate claims (quote-grounded but NOT adversarially verified — use only as a fallback when no confirmed claim answers, and label them low confidence)\n" +
    candidates
      .map(
        (claim) =>
          `### [${claim.id}] ${claim.text}\n` +
          `Source: ${claim.url} (${claim.sourceQuality}` +
          `${claim.publishedTime ? `, published ${claim.publishedTime}` : ""})\n` +
          `Quote: "${claim.quote}"\n`,
      )
      .join("\n")
  );
}

function renderRefutedClaims(refuted: ResearchClaim[]): string {
  if (refuted.length === 0) return "";
  return (
    "\n## Refuted claims (do NOT use these in the report except to note they were ruled out)\n" +
    refuted
      .map(
        (claim) =>
          `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)}) [${claim.id}]`,
      )
      .join("\n")
  );
}

const SYNTHESIS_SYSTEM_PROMPT =
  "You answer one research question from a set of source-cited claims, writing the final report directly as Markdown. " +
  "Prefer adversarially verified (confirmed) claims; contested claims may be reported as disagreements between sources; you may fall back to an unconfirmed candidate when no confirmed claim answers, but flag such an answer as low confidence and say why. " +
  "Never use a refuted claim except to note it was ruled out; never invent claims or sources; carry each statement's source URL. " +
  "Lead with the direct answer in the very first sentence. " +
  "Match length to the question: a single fact deserves 1-3 sentences with no headings; a broad question earns proportionally more, but never pad or fill sections. " +
  "Calibrate certainty to the evidence: state a well-confirmed answer plainly; lightly qualify a thin one; for an answer resting on unconfirmed or weak sources, still lead with the best candidate but explicitly flag that it is unverified and why. " +
  "Cite each factual statement inline as a Markdown link to its source URL, using only URLs present in the claims. " +
  "ADDITIONALLY, after every sentence that asserts a fact drawn from a claim, append a claim marker of the form {{claim_3}} (or {{claim_3,claim_7}} when a sentence rests on several claims), using the bracketed ids shown with each claim. The markers are machine-checked and stripped before the user sees the report — never omit them, never invent ids. " +
  "A confirmed claim may include a 'Source context' excerpt from its page; use it for precise wording and detail, but still cite the claim's source URL. " +
  "Surface a caveat only where it changes how the answer should be read, inline next to the point it qualifies. " +
  "Do not add generic 'Caveats' or 'Open Questions' sections.";

export function synthesisPrompt(opts: {
  question: string;
  partition: ClaimPartition;
  closingNote?: string | undefined;
  context?: ((claim: ResearchClaim) => string | undefined) | undefined;
}): string {
  const { confirmed, contested, refuted, candidates } = opts.partition;
  return (
    "## Answer the question\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${confirmed.length} claim(s) survived adversarial verification` +
    (candidates.length > 0
      ? `; ${candidates.length} more were extracted but not verified`
      : "") +
    ". Merge duplicates and write the report.\n\n" +
    "## Confirmed claims\n" +
    (confirmed.length > 0
      ? renderConfirmedClaims(confirmed, opts.context)
      : "(none)\n") +
    renderContestedClaims(contested) +
    renderCandidateClaims(candidates) +
    renderRefutedClaims(refuted) +
    (opts.closingNote ? `\n## Lead agent's closing note\n${opts.closingNote}\n` : "") +
    "\n## Write the report\n" +
    "Merge claims that say the same thing and combine their sources. " +
    "Lead with the direct answer in the first sentence, then the supporting detail. " +
    "Prefer confirmed claims; if they do not answer, you may answer from the single best-supported candidate and flag it low confidence, never from a refuted claim, never invented. " +
    "Scale length to the question — a single fact is 1-3 sentences with no headings; a broad question gets more, never padded. " +
    "Cite facts inline as Markdown links using only the source URLs above, and append {{claim_id}} markers after every factual sentence. " +
    "Render the report as Markdown for the user."
  );
}

export async function synthesizeReport(
  rctx: RunCtx,
  grant: BudgetGrant,
  opts: {
    partition: ClaimPartition;
    closingNote?: string | undefined;
  },
): Promise<string> {
  const model = rctx.bindModel("write", grant);
  rctx.emit({ type: "report.drafting" });
  const result = streamText({
    model,
    system: SYNTHESIS_SYSTEM_PROMPT,
    prompt: synthesisPrompt({
      question: rctx.question,
      partition: opts.partition,
      closingNote: opts.closingNote,
      context: (claim) => quoteContext(rctx, claim),
    }),
    maxOutputTokens: REPORT_MAX_TOKENS,
    maxRetries: MODEL_CALL_MAX_RETRIES,
    abortSignal: rctx.signal,
  });
  for await (const delta of result.textStream) {
    if (delta) rctx.emit({ type: "report.delta", text: delta });
  }
  return (await result.text).trim();
}

export function fallbackReportFromClaims(opts: {
  question: string;
  partition: ClaimPartition;
  closingNote?: string | undefined;
}): string {
  const { confirmed, contested, refuted, candidates } = opts.partition;
  const finding = (claim: ResearchClaim): string =>
    `- ${claim.text} — [${claim.title || claim.url}](${claim.url}) (vote ${voteSplit(claim)}, "${claim.quote}") {{${claim.id}}}`;
  const lines: string[] = [
    "# Findings",
    "",
    `**Question:** ${opts.question}`,
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
  if (contested.length > 0) {
    lines.push(
      "",
      `## Contested findings (${contested.length}) — sources disagree`,
      ...contested.map(finding),
    );
  }
  if (candidates.length > 0) {
    lines.push(
      "",
      `## Unrefuted but unverified (${candidates.length}) — treat as low confidence`,
      ...candidates.map(finding),
    );
  }
  if (opts.closingNote) {
    lines.push("", "## Lead agent's closing note", opts.closingNote);
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
