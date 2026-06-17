import { generateObject } from "ai";
import { withTraceFrame } from "./trace.js";
import { z } from "zod";
import { mapWithConcurrency } from "./async.js";
import type { BudgetGrant } from "./budget.js";
import { ECONOMY } from "./economy.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { normalizeForQuoteMatch, type ResearchClaim } from "./ledger.js";
import type { RunCtx } from "./state.js";

const SIMILARITY_THRESHOLD = 0.3;
const IMPORTANCE_RANK: Record<string, number> = {
  central: 0,
  supporting: 1,
  tangential: 2,
};
const PAIR_BATCH_SIZE = 40;
const PAIR_BATCH_CONCURRENCY = 3;
const JUDGE_MAX_TOKENS = 2_000;

const JUDGE_SYSTEM =
  "You judge pairs of extracted research claims. " +
  '"duplicate": both claims assert the same fact about the same entity — the same quantity, date, or event, allowing wording, rounding, and unit-format differences; the same evidence would corroborate both. ' +
  '"contradicts": the claims make incompatible assertions about the same entity and aspect — values, dates, rankings, or outcomes that cannot both be true as stated. Different aspects, periods, or measurement bases are not contradictions. ' +
  '"distinct": anything else. Structured output only.';

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int(),
      verdict: z.enum(["duplicate", "contradicts", "distinct"]),
    }),
  ),
});

function tokensOf(text: string): Set<string> {
  return new Set(
    normalizeForQuoteMatch(text)
      .split(/[^a-z0-9.%$]+/)
      .filter((token) => token.length >= 3 || /\d/.test(token)),
  );
}

function numericTokens(tokens: Set<string>): Set<string> {
  return new Set([...tokens].filter((token) => /\d/.test(token)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface CandidatePair {
  a: ResearchClaim;
  b: ResearchClaim;
  score: number;
}

export interface ConflictPairCaps {
  maxClaims: number;
  maxPairs: number;
}

export function candidateConflictPairs(
  input: ResearchClaim[],
  caps: ConflictPairCaps,
): CandidatePair[] {
  const claims =
    input.length > caps.maxClaims
      ? [...input]
          .sort(
            (a, b) =>
              (IMPORTANCE_RANK[a.importance] ?? 3) -
              (IMPORTANCE_RANK[b.importance] ?? 3),
          )
          .slice(0, caps.maxClaims)
      : input;
  const tokens = claims.map((claim) => tokensOf(claim.text));
  const numbers = tokens.map(numericTokens);
  const words = tokens.map(
    (set) => new Set([...set].filter((token) => !/\d/.test(token))),
  );
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      if (numbers[i].size > 0 && numbers[j].size > 0) {
        let sharedNumber = false;
        for (const token of numbers[i]) {
          if (numbers[j].has(token)) {
            sharedNumber = true;
            break;
          }
        }
        if (!sharedNumber) {
          const score = jaccard(words[i], words[j]);
          if (score >= SIMILARITY_THRESHOLD) {
            pairs.push({ a: claims[i], b: claims[j], score });
          }
          continue;
        }
      }
      const score = jaccard(tokens[i], tokens[j]);
      if (score >= SIMILARITY_THRESHOLD) {
        pairs.push({ a: claims[i], b: claims[j], score });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, caps.maxPairs);
}

function markConflict(
  a: ResearchClaim,
  b: ResearchClaim,
  toVerify: Set<string>,
): boolean {
  if (a.duplicateOf || b.duplicateOf || a.id === b.id) return false;
  let changed = false;
  const link = (claim: ResearchClaim, other: ResearchClaim) => {
    const conflicts = new Set(claim.conflictsWith ?? []);
    if (conflicts.has(other.id)) return;
    conflicts.add(other.id);
    claim.conflictsWith = [...conflicts];
    toVerify.add(claim.id);
    changed = true;
  };
  link(a, b);
  link(b, a);
  return changed;
}

export interface ConflictPassOutcome {
  merged: number;
  contradicted: number;
}

export async function conflictPass(
  rctx: RunCtx,
  grant: BudgetGrant,
): Promise<ConflictPassOutcome> {
  const envelope = rctx.config.envelope;
  const pairs = candidateConflictPairs(rctx.ledger.representatives(), {
    maxClaims: envelope.maxConflictClaims,
    maxPairs: envelope.maxConflictPairs,
  });
  const outcome: ConflictPassOutcome = { merged: 0, contradicted: 0 };
  if (pairs.length === 0) return outcome;
  const toVerify = new Set<string>();
  const model = rctx.bindModel("extract", grant);
  const batches: CandidatePair[][] = [];
  for (let offset = 0; offset < pairs.length; offset += PAIR_BATCH_SIZE) {
    batches.push(pairs.slice(offset, offset + PAIR_BATCH_SIZE));
  }
  await mapWithConcurrency(batches, PAIR_BATCH_CONCURRENCY, async (slice) => {
    if (grant.floored() || rctx.signal?.aborted) return;
    const batch = slice.filter(
      (pair) => !pair.a.duplicateOf && !pair.b.duplicateOf,
    );
    if (batch.length === 0) return;
    try {
      const result = await withTraceFrame(rctx.recorder, { site: "conflicts" }, () =>
        generateObject({
        model,
        system: JUDGE_SYSTEM,
        prompt:
          "## Claim pairs\n" +
          batch
            .map(
              (pair, index) =>
                `[${index}]\nA (${pair.a.id}): "${pair.a.text}"\nB (${pair.b.id}): "${pair.b.text}"`,
            )
            .join("\n\n") +
          "\n\nReturn one verdict per index: duplicate, contradicts, or distinct.",
        schema: verdictSchema,
        maxOutputTokens: JUDGE_MAX_TOKENS,
        maxRetries: MODEL_CALL_MAX_RETRIES,
        abortSignal: rctx.signal,
      }),
      );
      for (const item of result.object.verdicts) {
        const pair = batch[item.index];
        if (!pair) continue;
        if (item.verdict === "duplicate") {
          if (rctx.ledger.merge(pair.b.id, pair.a.id)) outcome.merged++;
        } else if (item.verdict === "contradicts") {
          if (markConflict(pair.a, pair.b, toVerify)) outcome.contradicted++;
        }
      }
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
    }
  });
  if (toVerify.size > 0 && !rctx.stopReason()) {
    try {
      await rctx.verify({
        claimIds: [...toVerify],
        reserve: rctx.verifyReserve,
        perClaimFraction: ECONOMY.verify.perClaimFraction,
        concurrency: ECONOMY.verify.concurrency,
        cap: envelope.maxConflictPairs,
      });
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
    }
  }
  if (outcome.merged > 0 || outcome.contradicted > 0) {
    rctx.emit({
      type: "tool.event",
      tool: "conflicts",
      data: { ...outcome, pairsChecked: pairs.length },
    });
  }
  return outcome;
}
