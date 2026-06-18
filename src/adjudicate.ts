import { generateObject } from "ai";
import { withTraceFrame } from "./trace.js";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import {
  applyCoverageUpdate,
  coverageUpdateSchema,
  isAnswered,
  renderChecklistAudit,
  type Checklist,
} from "./checklist.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { RunCtx } from "./state.js";
import { trailCapsFor } from "./trail.js";

const ADJUDICATION_MAX_TOKENS = 800;
const ADJUDICATION_DIGEST_CLAIMS = 80;
const ADJUDICATION_TRAIL_FRACTION = 0.25;

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

const CHECKLIST_COVERAGE_SYSTEM =
  "You audit one deep-research run against its coverage contract — a checklist of sub-facts a complete answer must ground with sources. " +
  "Working only from the ledger of verbatim-quoted claims and the trail of what was already searched, decide for each OPEN item whether it is now CLOSED: a ledger claim pins its exact value/date/entity (grounded), or the trail shows it was genuinely searched and the sources dead-ended (exhausted). An item near the topic but without its exact fact stays open. " +
  "The contract is living: if the ledger reveals a central sub-fact the answer needs that the contract is missing, add it. Structured output only.";

export async function adjudicateCoverage(
  rctx: RunCtx,
  grant: BudgetGrant,
  closingNote: string,
): Promise<CoverageVerdict | null> {
  if (grant.floored()) return null;
  if (rctx.checklist) {
    return adjudicateAgainstChecklist(rctx, grant, closingNote, rctx.checklist);
  }
  return adjudicateAgainstQuestion(rctx, grant, closingNote);
}

async function adjudicateAgainstQuestion(
  rctx: RunCtx,
  grant: BudgetGrant,
  closingNote: string,
): Promise<CoverageVerdict | null> {
  const trail = rctx.trail.render(
    trailCapsFor(rctx.config.maxSources, ADJUDICATION_TRAIL_FRACTION),
  );
  try {
    const result = await withTraceFrame(rctx.recorder, { site: "adjudicate" }, () =>
      generateObject({
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
    }),
    );
    return {
      answered: result.object.answered,
      gaps: result.object.gaps.map((gap) => gap.trim()).filter(Boolean),
    };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}

async function adjudicateAgainstChecklist(
  rctx: RunCtx,
  grant: BudgetGrant,
  closingNote: string,
  checklist: Checklist,
): Promise<CoverageVerdict | null> {
  const trail = rctx.trail.render(
    trailCapsFor(rctx.config.maxSources, ADJUDICATION_TRAIL_FRACTION),
  );
  try {
    const result = await withTraceFrame(rctx.recorder, { site: "adjudicate" }, () =>
      generateObject({
      model: rctx.bindModel("verify", grant),
      system: CHECKLIST_COVERAGE_SYSTEM,
      prompt:
        `Research question: ${rctx.question}\n\n` +
        `Lead agent's closing note:\n${closingNote || "(none)"}\n\n` +
        `Coverage contract (each item with its id, importance, volatility, status):\n${renderChecklistAudit(checklist)}\n\n` +
        `Ledger digest:\n${rctx.ledger.digest(ADJUDICATION_DIGEST_CLAIMS) || "(empty)"}\n\n` +
        (trail ? `Trail — what was already tried:\n${trail}\n\n` : "") +
        "Return three things. " +
        "closedIds: the ids of OPEN items that are now closed — grounded by a ledger claim carrying the exact fact, or genuinely exhausted per the trail (searched, sources dead-ended). " +
        "newItems: up to 4 central sub-facts the ledger reveals the answer needs but the contract is missing — omit anything already listed, and do not pad. " +
        "gaps: up to 5 directives a research agent could act on next, one per still-open item that most matters (volatile and central first), each naming the exact value/entity to pin; use the trail to avoid re-prescribing dead ends — phrase a stalled item as a genuinely different angle, term, or source.",
      schema: coverageUpdateSchema,
      maxOutputTokens: ADJUDICATION_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    }),
    );
    applyCoverageUpdate(checklist, {
      closedIds: result.object.closedIds,
      newItems: result.object.newItems,
    });
    return {
      answered: isAnswered(checklist),
      gaps: result.object.gaps.map((gap) => gap.trim()).filter(Boolean),
    };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}
