import { generateText, stepCountIs, streamText } from "ai";
import { createMarkerStripper, type BindOutcome } from "./bind.js";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { todayLine } from "./prompts.js";
import type { RunCtx } from "./state.js";
import { buildAgentTools, type AgentCtx, type ToolName } from "./tools.js";
import { voteSplit } from "./verify.js";
import type { ResearchClaim } from "./ledger.js";

const WRITE_MAX_TURNS = 8;
const WRITER_TOOLS: ToolName[] = ["search_sources", "read_source", "run_code"];
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
  screened: ResearchClaim[];
  contested: ResearchClaim[];
  refuted: ResearchClaim[];
  candidates: ResearchClaim[];
}

export function partitionClaims(
  claims: ResearchClaim[],
  maxCandidates: number = MAX_REPORT_CANDIDATES,
): ClaimPartition {
  const representatives = claims.filter((claim) => !claim.duplicateOf);
  const confirmed = representatives.filter(
    (claim) => claim.status === "confirmed",
  );
  const screened = representatives.filter(
    (claim) => claim.status === "screened",
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
    .slice(0, maxCandidates);
  return { confirmed, screened, contested, refuted, candidates };
}

export function quoteContext(
  rctx: RunCtx,
  claim: ResearchClaim,
): string | undefined {
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

function renderScreenedClaims(screened: ResearchClaim[]): string {
  if (screened.length === 0) return "";
  return (
    "\n## Screened claims (passed a cheap quote-and-evidence screening, NOT the adversarial panel — usable, but prefer confirmed claims and qualify when a screened claim carries the answer alone)\n" +
    screened
      .map(
        (claim) =>
          `### [${claim.id}] ${claim.text}\n` +
          `Source: ${claim.url} (${claim.sourceQuality}` +
          `${claim.publishedTime ? `, published ${claim.publishedTime}` : ""})\n` +
          `Quote: "${claim.quote}"\n` +
          (claim.corroboration && claim.corroboration > 1
            ? `Corroborated by ${claim.corroboration} independent sources\n`
            : ""),
      )
      .join("\n")
  );
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
  "Prefer adversarially verified (confirmed) claims, then screened claims (they passed a cheap quote-and-evidence check, not the adversarial panel); contested claims may be reported as disagreements between sources; you may fall back to an unconfirmed candidate when nothing stronger answers, but flag such an answer as low confidence and say why. " +
  "Never use a refuted claim except to note it was ruled out; never invent claims or sources; carry each statement's source URL. " +
  "Lead with the direct answer in the very first sentence. " +
  "Match length to the question: a single fact deserves 1-3 sentences with no headings; a broad question earns proportionally more, but never pad or fill sections. " +
  "Calibrate certainty to the evidence: state a well-confirmed answer plainly; lightly qualify a thin one; for an answer resting on unconfirmed or weak sources, still lead with the best candidate but explicitly flag that it is unverified and why. " +
  "Cite each factual statement inline as a Markdown link to its source URL, using only URLs present in the claims. " +
  "ADDITIONALLY, after every sentence that asserts a fact drawn from a claim, append a claim marker of the form {{claim_3}} (or {{claim_3,claim_7}} when a sentence rests on several claims), using the bracketed ids shown with each claim. The markers are machine-checked and stripped before the user sees the report — never omit them, never invent ids. " +
  "A confirmed claim may include a 'Source context' excerpt from its page; use it for precise wording and detail, but still cite the claim's source URL. " +
  "You may consult the stored sources before writing: search_sources finds passages, read_source reads exact text, run_code computes over them. " +
  "Use them to merge duplicates confidently and to recover precise wording, figures, units, and dates around the listed claims' quotes — a few tool turns at most; your final reply with no tool calls is the report itself. " +
  "That final reply must begin with the report's first sentence — no preamble, no announcement that you are about to write, no leading horizontal rule. " +
  "Source detail may sharpen a sentence, but every factual sentence still carries its {{claim_id}} marker and must stay within what that claim's source supports — markers are machine-checked against the claim, its quote, and the surrounding source text. " +
  "Surface a caveat only where it changes how the answer should be read, inline next to the point it qualifies. " +
  "Do not add generic 'Caveats' or 'Open Questions' sections.";

export function synthesisPrompt(opts: {
  question: string;
  partition: ClaimPartition;
  closingNote?: string | undefined;
  context?: ((claim: ResearchClaim) => string | undefined) | undefined;
}): string {
  const { confirmed, screened, contested, refuted, candidates } =
    opts.partition;
  return (
    "## Answer the question\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${confirmed.length} claim(s) survived adversarial verification` +
    (screened.length > 0 ? `; ${screened.length} passed screening` : "") +
    (candidates.length > 0
      ? `; ${candidates.length} more were extracted but not verified`
      : "") +
    ". Merge duplicates and write the report.\n\n" +
    "## Confirmed claims\n" +
    (confirmed.length > 0
      ? renderConfirmedClaims(confirmed, opts.context)
      : "(none)\n") +
    renderScreenedClaims(screened) +
    renderContestedClaims(contested) +
    renderCandidateClaims(candidates) +
    renderRefutedClaims(refuted) +
    (opts.closingNote ? `\n## Lead agent's closing note\n${opts.closingNote}\n` : "") +
    "\n## Write the report\n" +
    "Consult the stored sources first (search_sources, read_source, run_code) when exact wording, figures, or context matter; then write. " +
    "Merge claims that say the same thing and combine their sources. " +
    "Lead with the direct answer in the first sentence, then the supporting detail. " +
    "Prefer confirmed claims, then screened; if nothing stronger answers, you may answer from the single best-supported candidate and flag it low confidence, never from a refuted claim, never invented. " +
    "Scale length to the question — a single fact is 1-3 sentences with no headings; a broad question gets more, never padded. " +
    "Cite facts inline as Markdown links using only the source URLs above, and append {{claim_id}} markers after every factual sentence. " +
    "Render the report as Markdown for the user."
  );
}

const PREAMBLE_MAX_CHARS = 300;

function looksLikeNarration(block: string): boolean {
  const trimmed = block.trim();
  return (
    trimmed.length <= PREAMBLE_MAX_CHARS &&
    !trimmed.startsWith("#") &&
    !trimmed.includes("{{") &&
    !trimmed.includes("](")
  );
}

export function stripReportPreamble(report: string): string {
  const rule = /^([\s\S]*?)\n\s*(?:-{3,}|\*{3,}|_{3,})\s*\n/.exec(report);
  if (rule && looksLikeNarration(rule[1])) {
    return report.slice(rule[0].length).trim();
  }
  const blocks = report.split(/\n{2,}/);
  const first = blocks[0]?.trim() ?? "";
  if (
    blocks.length > 1 &&
    first.length > 0 &&
    looksLikeNarration(first) &&
    blocks[1].trim().startsWith("#")
  ) {
    return blocks.slice(1).join("\n\n").trim();
  }
  return report;
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
  const actx: AgentCtx = {
    agentId: "agent_write",
    role: "write",
    grant,
    depth: 0,
    spawnsThisStep: { count: 0 },
    extractModel: model,
    spawn: async () => "Spawning is unavailable during synthesis.",
  };
  const tools = buildAgentTools(rctx, actx, WRITER_TOOLS);
  const result = streamText({
    model,
    system: `${SYNTHESIS_SYSTEM_PROMPT}\n\n${todayLine()}`,
    prompt: synthesisPrompt({
      question: rctx.question,
      partition: opts.partition,
      closingNote: opts.closingNote,
      context: (claim) => quoteContext(rctx, claim),
    }),
    tools,
    stopWhen: [stepCountIs(WRITE_MAX_TURNS), () => grant.floored()],
    maxOutputTokens: rctx.config.envelope.maxReportTokens,
    maxRetries: MODEL_CALL_MAX_RETRIES,
    abortSignal: rctx.signal,
  });

  let lastText = "";
  let stepText = "";
  let streamedChars = 0;
  let stripper = createMarkerStripper();
  const emitDelta = (text: string): void => {
    if (!text) return;
    streamedChars += text.length;
    rctx.emit({ type: "report.delta", text });
  };
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      stepText += part.text;
      emitDelta(stripper.push(part.text));
    } else if (part.type === "finish-step") {
      if (stepText.trim()) lastText = stepText.trim();
      if (part.finishReason === "tool-calls") {
        stripper.flush();
        if (streamedChars > 0) rctx.emit({ type: "report.reset" });
      } else {
        emitDelta(stripper.flush());
      }
      stepText = "";
      streamedChars = 0;
      stripper = createMarkerStripper();
    } else if (part.type === "error") {
      throw part.error;
    }
  }
  rctx.signal?.throwIfAborted();
  return stripReportPreamble(lastText.trim());
}

const REPAIR_MAX_PROBLEMS = 24;

const REPAIR_SYSTEM_PROMPT =
  "You repair a research report draft so every factual sentence is supported by the claims it cites. " +
  "You receive the draft with {{claim_id}} markers, a list of problem sentences, and the claim ledger digest. " +
  "Fix ONLY the problem sentences: rewrite each to assert exactly what its cited claim supports (keeping a correct {{claim_id}} marker), " +
  "attach the right marker when a listed claim does support the sentence, or delete the sentence when nothing supports it. " +
  "Leave every other sentence unchanged. Never invent claims, sources, ids, or facts. " +
  "Return the full corrected draft and nothing else.";

export async function repairReport(
  rctx: RunCtx,
  grant: BudgetGrant,
  opts: { draft: string; bound: BindOutcome },
): Promise<string | undefined> {
  if (grant.floored()) return undefined;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const citation of opts.bound.citations) {
    if (citation.verified) continue;
    const sentence = opts.bound.report
      .slice(citation.sentenceSpan[0], citation.sentenceSpan[1])
      .trim();
    const key = `${sentence}|${citation.claimId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const claim = rctx.ledger.byId(citation.claimId);
    problems.push(
      `- Sentence: "${sentence}"\n` +
        `  Cited claim ${citation.claimId}: "${claim?.text ?? "unknown claim"}"\n` +
        `  Claim quote: "${claim?.quote ?? ""}"\n` +
        "  Problem: the sentence asserts more than this claim supports.",
    );
  }
  for (const sentence of opts.bound.unsupportedSentences) {
    problems.push(
      `- Sentence: "${sentence}"\n` +
        "  Problem: factual sentence with no claim marker.",
    );
  }
  if (problems.length === 0) return undefined;
  const result = await generateText({
    model: rctx.bindModel("write", grant),
    system: REPAIR_SYSTEM_PROMPT,
    prompt:
      `Research question: ${rctx.question}\n\n` +
      "## Draft (with claim markers)\n" +
      opts.draft +
      "\n\n## Problem sentences\n" +
      problems.slice(0, REPAIR_MAX_PROBLEMS).join("\n") +
      "\n\n## Claim ledger digest\n" +
      (rctx.ledger.digest() || "(empty)") +
      "\n\nReturn the corrected draft.",
    maxOutputTokens: rctx.config.envelope.maxReportTokens,
    maxRetries: MODEL_CALL_MAX_RETRIES,
    abortSignal: rctx.signal,
  });
  const repaired = stripReportPreamble(result.text.trim());
  return repaired || undefined;
}

export function fallbackReportFromClaims(opts: {
  question: string;
  partition: ClaimPartition;
  closingNote?: string | undefined;
}): string {
  const { confirmed, screened, contested, refuted, candidates } =
    opts.partition;
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
  if (screened.length > 0) {
    lines.push(
      "",
      `## Screened findings (${screened.length}) — passed screening, not the adversarial panel`,
      ...screened.map(finding),
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
