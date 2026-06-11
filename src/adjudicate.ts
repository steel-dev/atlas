import { generateObject } from "ai";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { RunCtx } from "./state.js";

const ADJUDICATION_MAX_TOKENS = 800;
const ADJUDICATION_DIGEST_CLAIMS = 80;
const ADJUDICATION_TRAIL_SEARCHES = 30;
const ADJUDICATION_TRAIL_DEAD_ENDS = 15;

const coverageSchema = z.object({
  answered: z.boolean(),
  gaps: z.array(z.string()).max(5),
});

export interface CoverageVerdict {
  answered: boolean;
  gaps: string[];
}

const COVERAGE_SYSTEM =
  "You audit one deep-research run: judge whether its ledger of verbatim-quoted claims is sufficient to answer the research question. " +
  "A ledger answers the question when its claims cover every facet the question actually asks, with the exact values, dates, or entities the answer needs. " +
  "Claims that are merely near the topic do not count as coverage. Structured output only.";

export async function adjudicateCoverage(
  rctx: RunCtx,
  grant: BudgetGrant,
  closingNote: string,
): Promise<CoverageVerdict | null> {
  if (grant.floored()) return null;
  const trail = rctx.trail.render({
    maxSearches: ADJUDICATION_TRAIL_SEARCHES,
    maxDeadEnds: ADJUDICATION_TRAIL_DEAD_ENDS,
  });
  try {
    const result = await generateObject({
      model: rctx.bindModel("verify", grant),
      system: COVERAGE_SYSTEM,
      prompt:
        `Research question: ${rctx.question}\n\n` +
        `Lead agent's closing note:\n${closingNote || "(none)"}\n\n` +
        `Ledger digest:\n${rctx.ledger.digest(ADJUDICATION_DIGEST_CLAIMS) || "(empty)"}\n\n` +
        (trail ? `Trail — what was already tried:\n${trail}\n\n` : "") +
        "Does this ledger contain the evidence needed to answer the question as asked? " +
        "If yes, return answered=true with gaps: []. If no, return answered=false and list up to 5 concrete, researchable gaps — a missing facet or entity, an unresolved disagreement between claims, or a missing exact value — each phrased as a directive a research agent could act on. " +
        "Do not list gaps that are tangential to the question, nor gaps the closing note already explains as unanswerable after a genuine attempt. " +
        "Use the trail to avoid re-prescribing what already failed: when a gap was already searched or its sources dead-ended, either drop it or phrase the directive as a genuinely different angle, term, or source.",
      schema: coverageSchema,
      maxOutputTokens: ADJUDICATION_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    });
    return {
      answered: result.object.answered,
      gaps: result.object.gaps.map((gap) => gap.trim()).filter(Boolean),
    };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}
