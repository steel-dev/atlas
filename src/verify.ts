import { generateObject } from "ai";
import { withTraceFrame } from "./trace.js";
import { z } from "zod";
import { mapWithConcurrency } from "./async.js";
import { runAgent } from "./agent.js";
import { withGrant, type BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { LEDGER_DATA_NOTE, QUARANTINE_NOTE, quarantine } from "./safety.js";
import type {
  RunCtx,
  VerifyScheduleArgs,
  VerifySpawnArgs,
  VerifySpawnOutcome,
  VerifySpawnVerdict,
} from "./state.js";
import type { ToolName } from "./tools.js";
import type {
  ClaimSourceQuality,
  ClaimVote,
  ResearchClaim,
} from "./ledger.js";
import {
  MIN_VOTES_TO_SETTLE,
  SCREENING_LENS,
  screenSufficient,
  settleClaim,
  voteSplit,
} from "./claim-status.js";
import { isTimeSensitive } from "./recency.js";

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
const VOTER_STEP_MAX_TOKENS = 1_200;
const VERDICT_MAX_TOKENS = 600;

const WEB_CONTRADICTION_QUALITIES = new Set<ClaimSourceQuality>([
  "blog",
  "forum",
  "unreliable",
]);

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
  QUARANTINE_NOTE +
  " " +
  LEDGER_DATA_NOTE;

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
    const envelope = rctx.config.envelope;
    const tools =
      lens === "contradiction" && envelope.verifierFetch
        ? [...LENS_TOOLS[lens], "fetch" as ToolName]
        : LENS_TOOLS[lens];
    const voter = await runAgent(rctx, {
      role: "verify",
      modelRole: envelope.panelModelRole,
      task,
      system: VERIFIER_SYSTEM,
      tools,
      grant: args.grant,
      depth: args.depth,
      parentId: args.parentId,
      maxTurns: envelope.verifierMaxTurns,
      maxOutputTokensPerStep: VOTER_STEP_MAX_TOKENS,
      finalTool: { name: "submit_verdict", inputSchema: verdictSchema },
    });
    if (rctx.stopReason()) return null;
    if (voter.final) {
      const parsed = verdictSchema.safeParse(voter.final);
      if (parsed.success) return { lens, ...parsed.data };
    }
    const verdict = await withTraceFrame(rctx.recorder, { site: "verify" }, () =>
      generateObject({
      model: rctx.bindModel(envelope.panelModelRole, args.grant),
      system: VERIFIER_SYSTEM,
      prompt:
        `${task}\n\nYou investigated this claim but did not record a verdict. ` +
        `Your findings:\n${voter.note || "(none)"}\n\n` +
        "Return your verdict now: refuted, evidence, confidence.",
      schema: verdictSchema,
      maxOutputTokens: VERDICT_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    }),
    );
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
  "Treat marketing copy, press releases, vendor self-description, cherry-picked benchmarks, and forum speculation as weak evidence: source_is_evidence stays true only if the page is genuinely informative, but drop to low confidence for such material. " +
  "When the question is time-sensitive and the source is visibly stale, lower confidence — a screening pass cannot confirm an outdated figure is still current. " +
  "Be calibrated: report low confidence whenever the context is too thin to be sure.\n\n" +
  QUARANTINE_NOTE +
  " " +
  LEDGER_DATA_NOTE;

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
  timeSensitive: boolean,
  todayISO: string,
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
    (timeSensitive
      ? `Today is ${todayISO} and this question is time-sensitive: weigh whether the source is recent enough for the claim to still hold.\n\n`
      : "") +
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
    const result = await withTraceFrame(rctx.recorder, { site: "screen" }, () =>
      generateObject({
      model: rctx.bindModel("verify", grant),
      system: SCREEN_SYSTEM,
      prompt: screenPrompt(
        rctx.question,
        claim,
        context,
        isTimeSensitive(rctx.question),
        rctx.todayISO,
      ),
      schema: screenSchema,
      maxOutputTokens: SCREEN_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    }),
    );
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

async function collectVotes(
  rctx: RunCtx,
  args: VerifySpawnArgs,
  claim: ResearchClaim,
  lenses: VerifierLens[],
  opts: { lensesExplicit: boolean; panelAffordable: boolean },
): Promise<ClaimVote[]> {
  const conflicted = (claim.conflictsWith?.length ?? 0) > 0;
  const wantsPanel =
    opts.lensesExplicit || conflicted || claim.importance === "central";
  const screenedVotes = claim.status === "screened" ? claim.votes : null;

  // Tier 0 — cheap screen. The target for claims we would not panel anyway, and a
  // fallback when the panel is unaffordable. A conflicted claim is never settled as
  // merely "screened"; it always escalates to the panel to adjudicate the conflict.
  if (!(wantsPanel && opts.panelAffordable) && !conflicted) {
    const screened = screenedVotes ?? (await screenClaim(rctx, args.grant, claim));
    if (screened && screened.length > 0) return screened;
    if (!opts.panelAffordable) return [];
  }

  // Tier 1 — adversarial panel.
  const panelLenses = opts.lensesExplicit
    ? lenses
    : lenses.filter(
        (lens) =>
          lens !== "contradiction" ||
          conflicted ||
          WEB_CONTRADICTION_QUALITIES.has(claim.sourceQuality),
      );
  const panel = (
    await Promise.all(
      panelLenses.map((lens) => castVote(rctx, args, claim, lens)),
    )
  ).filter((vote): vote is ClaimVote => vote !== null);
  return panel.length > 0 ? panel : (screenedVotes ?? []);
}

function recordPanelShadow(
  rctx: RunCtx,
  claim: ResearchClaim,
  votes: ClaimVote[],
): void {
  const paneled = votes.some((vote) => vote.lens !== SCREENING_LENS);
  if (!paneled) return;
  rctx.counters.verifyPanelRuns++;
  if (!screenSufficient(claim)) return;
  if (claim.status === "confirmed") {
    rctx.counters.verifyPanelDowngradable++;
  } else if (claim.status === "contested" || claim.status === "refuted") {
    rctx.counters.verifyPanelCheapMisses++;
  }
}

async function verifyClaim(
  rctx: RunCtx,
  args: VerifySpawnArgs,
  claim: ResearchClaim,
  lenses: VerifierLens[],
  lensesExplicit: boolean,
): Promise<void> {
  const inFlight = rctx.verifyInFlight.get(claim.id);
  if (inFlight) {
    await inFlight;
    return;
  }
  if (claim.votes.length >= MIN_VOTES_TO_SETTLE) return;
  const conflicted = (claim.conflictsWith?.length ?? 0) > 0;
  const panelAffordable =
    lensesExplicit ||
    args.grant.remainingUSD() >= rctx.config.envelope.panelGrantUSD;
  // A conflicted claim we cannot fund a panel for is left for a better-funded pass; we
  // still surface the known disagreement as contested rather than spending on a screen
  // that would mislabel it "screened".
  if (conflicted && !panelAffordable) {
    if (claim.votes.length === 0) {
      settleClaim(claim, []);
      rctx.emit({
        type: "claim.verified",
        claimId: claim.id,
        status: claim.status,
        votes: voteSplit(claim),
      });
    }
    return;
  }
  const job = (async () => {
    const votes = await collectVotes(rctx, args, claim, lenses, {
      lensesExplicit,
      panelAffordable,
    });
    settleClaim(claim, votes);
    rctx.counters.claimsVerified++;
    recordPanelShadow(rctx, claim, votes);
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
}

export async function verifyClaims(
  rctx: RunCtx,
  args: VerifyScheduleArgs,
): Promise<VerifySpawnOutcome> {
  const lensesExplicit = (args.lenses ?? []).some((lens) =>
    (ALL_LENSES as string[]).includes(lens),
  );
  const lenses = normalizeLenses(args.lenses);
  const claims = args.claimIds
    .slice(0, args.cap ?? MAX_CLAIMS_PER_SPAWN)
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
  await mapWithConcurrency(unique, args.concurrency, async (claim) => {
    if (rctx.signal?.aborted) return;
    await withGrant(
      args.reserve,
      {
        fraction: args.perClaimFraction,
        minUSD: rctx.config.envelope.panelGrantUSD,
      },
      (grant) =>
        verifyClaim(
          rctx,
          {
            claimIds: [claim.id],
            grant,
            ...(args.lenses ? { lenses: args.lenses } : {}),
            depth: args.depth ?? 1,
            ...(args.parentId ? { parentId: args.parentId } : {}),
          },
          claim,
          lenses,
          lensesExplicit,
        ),
    );
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
