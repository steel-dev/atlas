import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import { mapWithConcurrency } from "./async.js";
import { runAgent } from "./agent.js";
import type { BudgetGrant } from "./budget.js";
import { ECONOMY } from "./economy.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { QUARANTINE_NOTE, quarantine } from "./safety.js";
import type {
  RunCtx,
  VerifySpawnArgs,
  VerifySpawnOutcome,
  VerifySpawnVerdict,
} from "./state.js";
import type { ToolName } from "./tools.js";
import type { ClaimVote, ResearchClaim } from "./ledger.js";
import {
  MIN_VOTES_TO_SETTLE,
  SCREENING_LENS,
  settleClaim,
  voteSplit,
} from "./claim-status.js";

export { SCREENING_LENS, settleClaim, voteSplit } from "./claim-status.js";

export type VerifierLens =
  | "quote-fidelity"
  | "contradiction"
  | "source-strength";

export const ALL_LENSES: VerifierLens[] = [
  "quote-fidelity",
  "contradiction",
  "source-strength",
];

const MAX_CLAIMS_PER_SPAWN = 8;
const CLAIM_CONCURRENCY = 4;
const VOTER_MAX_TURNS = 6;
const VOTER_STEP_MAX_TOKENS = 1_200;
const VERDICT_MAX_TOKENS = 600;

const LENS_TOOLS: Record<VerifierLens, ToolName[]> = {
  "quote-fidelity": ["read_source", "search_sources", "run_code"],
  contradiction: ["search"],
  "source-strength": ["read_source", "search_sources"],
};

const LENS_INSTRUCTIONS: Record<VerifierLens, string> = {
  "quote-fidelity":
    "Does the quote, in its surrounding context, actually support the claim — or is it an overreach, misread, or out-of-context fragment? " +
    "Use search_sources to locate the quote span, read_source to read the text around it, and run_code to check exact values. " +
    "refuted=true if the claim overstates, misreads, or cherry-picks the quote. refuted=false ONLY if the full context supports the claim as stated.",
  contradiction:
    "Search the web for evidence that contradicts or heavily qualifies this claim. " +
    "Run 1-2 targeted queries: counterclaims, more recent figures, disputes, corrections. " +
    "refuted=true if any credible result contradicts or heavily qualifies the claim, or shows it is outdated. refuted=false ONLY if you find no credible contradiction.",
  "source-strength":
    "Judge how strong this source is for the claim and whether the claim is current, then express that as confidence — not as a refutation. " +
    "Primary sources and corroboration are strong; marketing copy, press releases, cherry-picked benchmarks, blogs, and forum speculation are weak; stale claims about fast-moving topics are suspect. " +
    "Use read_source around the quote to judge the page's nature and date. " +
    "refuted=true ONLY if the source is not real evidence at all — spam, ads, fabrication, or a page that does not actually concern the claim. " +
    "For a merely weak, thin, or stale source, set refuted=false with confidence=low: weakness lowers confidence, it does not kill the claim.",
};

const VERIFIER_SYSTEM =
  "You are one of several independent adversarial verifiers judging one claim from a research run. " +
  "Be SKEPTICAL: probe the claim through your assigned lens. A quorum of refutations kills the claim; a single refutation marks it contested. " +
  "Refute only when you find a concrete, nameable problem — a misquote, a credible contradiction, or a source that is not real evidence. " +
  "Uncertainty alone, or a merely weak source, is not grounds to refute; reflect that through low confidence instead. " +
  "Evidence must be specific — quote or cite what you checked.\n\n" +
  QUARANTINE_NOTE;

const verdictSchema = z.object({
  refuted: z.boolean(),
  evidence: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

function voterPrompt(
  question: string,
  claim: ResearchClaim,
  lens: VerifierLens,
  rivals: ResearchClaim[] = [],
): string {
  return (
    "## Claim under review\n" +
    `"${claim.text}"\n\n` +
    `Source: ${claim.url} (${claim.sourceQuality}, published ${claim.publishedTime ?? "unknown"}) · source_id ${claim.sourceId}\n` +
    `Supporting quote (mechanically verified to appear verbatim in the stored source text):\n"${claim.quote}"\n\n` +
    `Research question: "${question}"\n\n` +
    `## Your lens: ${lens}\n` +
    LENS_INSTRUCTIONS[lens] +
    (rivals.length > 0
      ? "\n\n## Conflicting ledger claims\n" +
        "The run's own ledger holds claims that appear to contradict this one:\n" +
        rivals
          .map((rival) => `- ${rival.id} (${rival.url}): "${rival.text}"`)
          .join("\n") +
        "\nAdjudicate the conflict: search for evidence showing which side is right. refuted=true if the evidence favors a conflicting claim."
      : "") +
    "\n\n" +
    "Use your tools to investigate as far as the claim warrants — a turn or two is usual, more when it is genuinely contested. Stop as soon as you can judge it; do not run searches you do not need. When you stop calling tools, briefly state your finding."
  );
}

async function castVote(
  rctx: RunCtx,
  args: VerifySpawnArgs,
  claim: ResearchClaim,
  lens: VerifierLens,
): Promise<ClaimVote | null> {
  if (args.grant.floored()) return null;
  try {
    const rivals =
      lens === "contradiction"
        ? (claim.conflictsWith ?? [])
            .map((id) => rctx.ledger.byId(id))
            .filter((rival): rival is ResearchClaim => rival !== undefined)
        : [];
    const task = voterPrompt(rctx.question, claim, lens, rivals);
    const voter = await runAgent(rctx, {
      role: "verify",
      modelRole: "verify",
      task,
      system: VERIFIER_SYSTEM,
      tools: LENS_TOOLS[lens],
      grant: args.grant,
      depth: args.depth,
      parentId: args.parentId,
      maxTurns: VOTER_MAX_TURNS,
      maxOutputTokensPerStep: VOTER_STEP_MAX_TOKENS,
      captureMessages: true,
    });
    if (rctx.stopReason()) return null;
    const transcript: ModelMessage[] = [
      { role: "user", content: task },
      ...(voter.messages ?? []),
      {
        role: "user",
        content:
          "Return your verdict now as structured output: refuted, evidence, confidence.",
      },
    ];
    const verdict = await generateObject({
      model: rctx.bindModel("verify", args.grant),
      system: VERIFIER_SYSTEM,
      messages: transcript,
      schema: verdictSchema,
      maxOutputTokens: VERDICT_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    });
    return { lens, ...verdict.object };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}

const SCREEN_CONTEXT_WINDOW = 600;
const SCREEN_MAX_TOKENS = 700;

const SCREEN_SYSTEM =
  "You are a fast screening verifier for one claim from a research run. Judge from the provided quote and its surrounding context only — no tools. " +
  "Decide (1) whether the quote, in context, supports the claim as stated without overreach, and (2) whether the page looks like real evidence rather than spam, an error page, or ads. " +
  "Be calibrated: report low confidence whenever the context is too thin to be sure.\n\n" +
  QUARANTINE_NOTE;

const screenSchema = z.object({
  quote_supports_claim: z.boolean(),
  source_is_evidence: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  note: z.string(),
});

function screenPrompt(
  question: string,
  claim: ResearchClaim,
  context: string | undefined,
): string {
  return (
    "## Claim under screening\n" +
    `"${claim.text}"\n\n` +
    `Source: ${claim.url} (${claim.sourceQuality}, published ${claim.publishedTime ?? "unknown"})\n` +
    `Supporting quote (mechanically verified to appear verbatim in the stored source text):\n"${claim.quote}"\n\n` +
    (context
      ? "Source context around the quote:\n" +
        quarantine(context, { sourceId: claim.sourceId, url: claim.url }) +
        "\n\n"
      : "") +
    `Research question: "${question}"\n\n` +
    "Judge support and evidence quality, then return the structured verdict."
  );
}

export async function screenClaim(
  rctx: RunCtx,
  grant: BudgetGrant,
  claim: ResearchClaim,
): Promise<ClaimVote[] | null> {
  if (grant.floored()) return null;
  const document = rctx.sources.byId.get(claim.sourceId);
  if (!document) return null;
  const idx = document.markdown.indexOf(claim.quote);
  const context =
    idx >= 0
      ? document.markdown.slice(
          Math.max(0, idx - SCREEN_CONTEXT_WINDOW),
          Math.min(
            document.markdown.length,
            idx + claim.quote.length + SCREEN_CONTEXT_WINDOW,
          ),
        )
      : undefined;
  try {
    const result = await generateObject({
      model: rctx.bindModel("verify", grant),
      system: SCREEN_SYSTEM,
      prompt: screenPrompt(rctx.question, claim, context),
      schema: screenSchema,
      maxOutputTokens: SCREEN_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    });
    const screen = result.object;
    if (
      !screen.quote_supports_claim ||
      !screen.source_is_evidence ||
      screen.confidence === "low"
    ) {
      return null;
    }
    return [
      {
        lens: SCREENING_LENS,
        refuted: false,
        evidence: screen.note,
        confidence: screen.confidence,
      },
    ];
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}

function normalizeLenses(lenses: string[] | undefined): VerifierLens[] {
  if (!lenses || lenses.length === 0) return ALL_LENSES;
  const valid = lenses.filter((lens): lens is VerifierLens =>
    (ALL_LENSES as string[]).includes(lens),
  );
  return valid.length > 0 ? [...new Set(valid)] : ALL_LENSES;
}

export async function runVerifySpawn(
  rctx: RunCtx,
  args: VerifySpawnArgs,
): Promise<VerifySpawnOutcome> {
  const lensesExplicit = (args.lenses ?? []).some((lens) =>
    (ALL_LENSES as string[]).includes(lens),
  );
  const lenses = normalizeLenses(args.lenses);
  const claims = args.claimIds
    .slice(0, MAX_CLAIMS_PER_SPAWN)
    .map((id) => rctx.ledger.byId(id))
    .filter((claim): claim is ResearchClaim => claim !== undefined)
    .map((claim) =>
      claim.duplicateOf
        ? (rctx.ledger.byId(claim.duplicateOf) ?? claim)
        : claim,
    );

  const unique = [...new Map(claims.map((claim) => [claim.id, claim])).values()];

  const verdictOf = (claim: ResearchClaim): VerifySpawnVerdict => ({
    claimId: claim.id,
    status: claim.status,
    votes: voteSplit(claim),
  });

  const verdicts: VerifySpawnVerdict[] = [];
  await mapWithConcurrency(unique, CLAIM_CONCURRENCY, async (claim) => {
    const inFlight = rctx.verifyInFlight.get(claim.id);
    if (inFlight) {
      await inFlight;
      verdicts.push(verdictOf(claim));
      return;
    }
    if (claim.votes.length >= MIN_VOTES_TO_SETTLE) {
      verdicts.push(verdictOf(claim));
      return;
    }
    const conflicted = (claim.conflictsWith?.length ?? 0) > 0;
    const panelAffordable =
      lensesExplicit ||
      args.grant.remainingUSD() >= ECONOMY.panelMinRemainingUSD;
    if (conflicted && !panelAffordable) {
      verdicts.push(verdictOf(claim));
      return;
    }
    const job = (async () => {
      const alreadyScreened = claim.status === "screened";
      let votes: ClaimVote[] | null = null;
      if (
        !lensesExplicit &&
        !conflicted &&
        !alreadyScreened &&
        (claim.importance !== "central" || !panelAffordable)
      ) {
        votes = await screenClaim(rctx, args.grant, claim);
      }
      if (!votes) {
        const panel = panelAffordable
          ? (
              await Promise.all(
                lenses.map((lens) => castVote(rctx, args, claim, lens)),
              )
            ).filter((vote): vote is ClaimVote => vote !== null)
          : [];
        votes = panel.length === 0 && alreadyScreened ? claim.votes : panel;
      }
      settleClaim(claim, votes);
      rctx.counters.claimsVerified++;
      rctx.emit({
        type: "claim.verified",
        claimId: claim.id,
        status: claim.status,
        votes: voteSplit(claim),
      });
    })();
    rctx.verifyInFlight.set(claim.id, job);
    try {
      await job;
    } finally {
      rctx.verifyInFlight.delete(claim.id);
    }
    verdicts.push(verdictOf(claim));
  });

  const confirmed = verdicts.filter((v) => v.status === "confirmed").length;
  const refuted = verdicts.filter((v) => v.status === "refuted").length;
  const contested = verdicts.filter((v) => v.status === "contested").length;
  const unverified = verdicts.filter((v) => v.status === "unverified").length;
  return {
    verdicts,
    note: `Verified ${verdicts.length} claim(s): ${confirmed} confirmed, ${contested} contested, ${refuted} refuted, ${unverified} unverified (too few votes).`,
  };
}
