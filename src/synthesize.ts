import { generateText, stepCountIs, streamText } from "ai";
import { withTraceFrame } from "./trace.js";
import { createMarkerStripper, type BindOutcome } from "./bind.js";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { todayLine } from "./prompts.js";
import type { RunCtx } from "./state.js";
import { buildAgentTools, type AgentCtx, type ToolName } from "./tools.js";
import { renderAnalyticalDemands } from "./checklist.js";
import { voteSplit } from "./verify.js";
import { isTimeSensitive, recencyScore } from "./recency.js";
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

const CONTESTED_RENDER_FLOOR = 12;
const RECENCY_RANK_MARGIN = 0.2;

export interface RecencyContext {
  todayISO: string;
  timeSensitive: boolean;
}

function recencyOf(claim: ResearchClaim, recency: RecencyContext): number {
  return recencyScore(claim.publishedTime, recency.todayISO);
}

export function recencyContext(rctx: RunCtx): RecencyContext {
  return {
    todayISO: rctx.todayISO,
    timeSensitive: isTimeSensitive(rctx.question),
  };
}

function makeReportClaimRank(
  recency?: RecencyContext,
): (a: ResearchClaim, b: ResearchClaim) => number {
  return (a, b) => {
    if (recency?.timeSensitive) {
      const delta = recencyOf(b, recency) - recencyOf(a, recency);
      if (Math.abs(delta) >= RECENCY_RANK_MARGIN) return delta;
    }
    const base =
      CANDIDATE_IMPORTANCE_RANK[a.importance] -
        CANDIDATE_IMPORTANCE_RANK[b.importance] ||
      (b.corroboration ?? 1) - (a.corroboration ?? 1) ||
      CANDIDATE_QUALITY_RANK[a.sourceQuality] -
        CANDIDATE_QUALITY_RANK[b.sourceQuality];
    if (base !== 0) return base;
    if (recency) return recencyOf(b, recency) - recencyOf(a, recency);
    return 0;
  };
}

export function capPartitionForReport(
  partition: ClaimPartition,
  maxClaims: number,
  recency?: RecencyContext,
): { partition: ClaimPartition; omitted: number } {
  const reportClaimRank = makeReportClaimRank(recency);
  const total =
    partition.confirmed.length +
    partition.screened.length +
    partition.contested.length;
  if (total <= maxClaims) return { partition, omitted: 0 };
  const contestedFloor = Math.min(
    partition.contested.length,
    CONTESTED_RENDER_FLOOR,
    maxClaims,
  );
  let remaining = maxClaims - contestedFloor;
  const confirmed = [...partition.confirmed]
    .sort(reportClaimRank)
    .slice(0, Math.max(0, remaining));
  remaining -= confirmed.length;
  const screened = [...partition.screened]
    .sort(reportClaimRank)
    .slice(0, Math.max(0, remaining));
  remaining -= screened.length;
  const contested = [...partition.contested]
    .sort(reportClaimRank)
    .slice(0, contestedFloor + Math.max(0, remaining));
  return {
    partition: { ...partition, confirmed, screened, contested },
    omitted: total - confirmed.length - screened.length - contested.length,
  };
}

export function partitionClaims(
  claims: ResearchClaim[],
  maxCandidates: number = MAX_REPORT_CANDIDATES,
  recency?: RecencyContext,
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
    (claim) => claim.status === "unverified",
  );
  const candidates = unverified
    .slice()
    .sort((a, b) => {
      if (recency?.timeSensitive) {
        const delta = recencyOf(b, recency) - recencyOf(a, recency);
        if (Math.abs(delta) >= RECENCY_RANK_MARGIN) return delta;
      }
      const base =
        CANDIDATE_IMPORTANCE_RANK[a.importance] -
          CANDIDATE_IMPORTANCE_RANK[b.importance] ||
        CANDIDATE_QUALITY_RANK[a.sourceQuality] -
          CANDIDATE_QUALITY_RANK[b.sourceQuality];
      if (base !== 0) return base;
      if (recency) return recencyOf(b, recency) - recencyOf(a, recency);
      return 0;
    })
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
  "Use the evidence you were given: every confirmed or screened claim that bears on the question belongs in the report — do not answer from a subset and leave grounded, on-topic claims uncited. " +
  "When the question asks you to choose — a recommendation, a ranking, a single best option — commit to one answer and defend it from the claims rather than retreating to a balanced summary that lists options without choosing. " +
  "Cite each factual statement inline as a Markdown link to its source URL, using only URLs present in the claims. " +
  "ADDITIONALLY, after every sentence that asserts a fact drawn from a claim, append a claim marker of the form {{claim_3}} (or {{claim_3,claim_7}} when a sentence rests on several claims), using the bracketed ids shown with each claim. The markers are machine-checked and stripped before the user sees the report — never omit them, never invent ids. " +
  "A confirmed claim may include a 'Source context' excerpt from its page; use it for precise wording and detail, but still cite the claim's source URL. " +
  "You may consult the stored sources before writing: search_sources finds passages, read_source reads exact text, run_code computes over them. " +
  "Use them to merge duplicates confidently and to recover precise wording, figures, units, and dates around the listed claims' quotes — a few tool turns at most; your final reply with no tool calls is the report itself. " +
  "That final reply must begin with the report's first sentence — no preamble, no announcement that you are about to write, no leading horizontal rule. " +
  "Source detail may sharpen a sentence, but every factual sentence still carries its {{claim_id}} marker(s) and must stay within what its cited claims support — markers are machine-checked against those claims, their quotes, and the surrounding source text. When a sentence combines facts from several claims, cite them together as {{claim_3,claim_7}}: a composed sentence passes as long as each part traces to one of its cited claims, so prefer composing cited facts into one informative sentence over flattening the report into one fact per sentence. " +
  "Surface a caveat only where it changes how the answer should be read, inline next to the point it qualifies. " +
  "Do not add generic 'Caveats' or 'Open Questions' sections.";

export function synthesisPrompt(opts: {
  question: string;
  partition: ClaimPartition;
  closingNote?: string | undefined;
  analyticalDemands?: string | undefined;
  context?: ((claim: ResearchClaim) => string | undefined) | undefined;
  omitted?: number | undefined;
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
    ". Merge duplicates and write the report." +
    (opts.omitted && opts.omitted > 0
      ? ` (${opts.omitted} lower-ranked claims are not shown here; search_sources and read_source still reach their sources.)`
      : "") +
    "\n\n" +
    "## Confirmed claims\n" +
    (confirmed.length > 0
      ? renderConfirmedClaims(confirmed, opts.context)
      : "(none)\n") +
    renderScreenedClaims(screened) +
    renderContestedClaims(contested) +
    renderCandidateClaims(candidates) +
    renderRefutedClaims(refuted) +
    (opts.closingNote ? `\n## Lead agent's closing note\n${opts.closingNote}\n` : "") +
    (opts.analyticalDemands
      ? `\n## Comparative & analytical points the answer must develop\n${opts.analyticalDemands}\n` +
        "These are reasoning moves over the grounded facts above — make each one explicit in the report (a comparison across cases, a tension that drives the topic, a cross-case synthesis, a causal explanation), not left implicit behind a list of facts. They rest on the cited facts and need no citations of their own. Develop them in addition to the facts, not instead of them.\n"
      : "") +
    "\n## Write the report\n" +
    "Consult the stored sources first (search_sources, read_source, run_code) when exact wording, figures, or context matter; then write. " +
    "Merge claims that say the same thing and combine their sources. " +
    "Lead with the direct answer in the first sentence. For a broad or comparison question, open with a short labeled summary block — a heading such as `## Bottom line` followed by 2-4 sentences that state the recommendation or key findings up front — before the detailed sections (a single-fact question needs no summary). " +
    "Prefer confirmed claims, then screened; if nothing stronger answers, you may answer from the single best-supported candidate and flag it low confidence, never from a refuted claim, never invented. " +
    "Scale length to the question — a single fact is 1-3 sentences with no headings; a broad question gets more, never padded. " +
    "Use lists or tables to organize multi-item comparisons rather than flattening them into prose. " +
    "Specific named facts are the answer, not minor detail: keep each grounded fact's exact name, date, figure, case, or statute rather than collapsing it into a generic category, and do not drop a grounded specific to save space — a broad question should carry every grounded specific it has, and a table cell must name the specific value, not a generic label. " +
    "Cover the evidence, not a sample: incorporate every confirmed or screened claim above that bears on the question — an on-topic grounded claim left uncited is lost coverage, not concision. " +
    "When the question asks you to choose, name one answer and justify it from the claims; do not hedge into a balanced comparison that withholds the choice. " +
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
  const capped = capPartitionForReport(
    opts.partition,
    rctx.config.envelope.maxReportClaims,
    recencyContext(rctx),
  );
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
    system: `${SYNTHESIS_SYSTEM_PROMPT}\n\n${todayLine(rctx.todayISO)}`,
    prompt: synthesisPrompt({
      question: rctx.question,
      partition: capped.partition,
      closingNote: opts.closingNote,
      analyticalDemands: rctx.checklist
        ? renderAnalyticalDemands(rctx.checklist) || undefined
        : undefined,
      context: (claim) => quoteContext(rctx, claim),
      omitted: capped.omitted,
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
  const draft = stripReportPreamble(lastText.trim());
  emitSynthesisDiagnostics(rctx, capped, draft);
  return draft;
}

function emitSynthesisDiagnostics(
  rctx: RunCtx,
  capped: { partition: ClaimPartition; omitted: number },
  draft: string,
): void {
  const kept =
    capped.partition.confirmed.length +
    capped.partition.screened.length +
    capped.partition.contested.length;
  rctx.emit({
    type: "tool.event",
    tool: "synthesis.capped",
    data: { total: kept + capped.omitted, kept, omitted: capped.omitted },
  });
  const provided = [
    ...capped.partition.confirmed,
    ...capped.partition.screened,
    ...capped.partition.contested,
    ...capped.partition.candidates,
  ];
  const providedIds = new Set(provided.map((claim) => claim.id));
  const cited = new Set<string>();
  for (const match of draft.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    for (const raw of match[1].split(",")) {
      const id = raw.trim();
      if (providedIds.has(id)) cited.add(id);
    }
  }
  const unusedClaimIds = [...providedIds].filter((id) => !cited.has(id));
  rctx.emit({
    type: "tool.event",
    tool: "synthesis.utilization",
    data: {
      provided: providedIds.size,
      cited: cited.size,
      unused: unusedClaimIds.length,
      unusedClaimIds: unusedClaimIds.slice(0, 80),
    },
  });
}

const REPAIR_MAX_PROBLEMS = 24;

const REPAIR_SYSTEM_PROMPT =
  "You repair a research report draft so every factual sentence is supported by the claims it cites. " +
  "You receive the draft with {{claim_id}} markers, a list of problem sentences, and the claim ledger digest. " +
  "Fix ONLY the listed problem sentences; leave every other sentence and its markers exactly as they are. " +
  "Prefer the least destructive fix, in this order: (1) re-cite — attach or add the {{claim_id}} markers that do support the sentence, citing several jointly as {{claim_3,claim_7}} when it composes them; (2) trim — narrow the sentence to exactly what its cited claims support together; (3) delete — only when no ledger claim supports any part of the sentence. " +
  "Keep a composed sentence composed — never split it into one fact per sentence — and never drop a sentence that is already supported just to shorten the draft. " +
  "Never invent claims, sources, ids, or facts. " +
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
    const problem =
      claim === undefined
        ? "the marker cites a claim id that does not exist in the ledger; attach a real claim that supports the sentence or delete it."
        : citation.status === "refuted"
          ? "the cited claim was refuted during verification; either state that it was ruled out or delete the sentence."
          : "the sentence asserts more than its cited claims support together; trim it to what they jointly establish, or cite an additional ledger claim that covers the rest.";
    problems.push(
      `- Sentence: "${sentence}"\n` +
        `  Cited claim ${citation.claimId}: "${claim?.text ?? "unknown claim"}"\n` +
        `  Claim quote: "${claim?.quote ?? ""}"\n` +
        `  Problem: ${problem}`,
    );
  }
  for (const sentence of opts.bound.unsupportedSentences) {
    problems.push(
      `- Sentence: "${sentence}"\n` +
        "  Problem: factual sentence with no claim marker.",
    );
  }
  if (problems.length === 0) return undefined;
  const result = await withTraceFrame(rctx.recorder, { site: "repair" }, () =>
    generateText({
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
  }),
  );
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
