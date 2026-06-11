import { generateObject } from "ai";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { normalizeForQuoteMatch, type ResearchClaim } from "./ledger.js";
import type { RunCtx } from "./state.js";

const SIMILARITY_THRESHOLD = 0.3;
const MAX_PAIRS = 150;
const PAIR_BATCH_SIZE = 40;
const JUDGE_MAX_TOKENS = 2_000;

const JUDGE_SYSTEM =
  "You judge whether pairs of extracted research claims assert the same fact. " +
  "A pair is duplicate when both claims would be corroborated by the same evidence: the same entity and the same quantity, date, or event, allowing wording, rounding, and unit-format differences. " +
  "Claims about different aspects, periods, quantities, or entities are not duplicates. Structured output only.";

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({ index: z.number().int(), duplicate: z.boolean() }),
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

export function candidateDuplicatePairs(
  claims: ResearchClaim[],
): CandidatePair[] {
  const tokens = claims.map((claim) => tokensOf(claim.text));
  const numbers = tokens.map(numericTokens);
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
        if (!sharedNumber) continue;
      }
      const score = jaccard(tokens[i], tokens[j]);
      if (score >= SIMILARITY_THRESHOLD) {
        pairs.push({ a: claims[i], b: claims[j], score });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, MAX_PAIRS);
}

export async function semanticDedupePass(
  rctx: RunCtx,
  grant: BudgetGrant,
): Promise<number> {
  const pairs = candidateDuplicatePairs(rctx.ledger.representatives());
  if (pairs.length === 0) return 0;
  const model = rctx.bindModel("extract", grant);
  let merged = 0;
  for (let offset = 0; offset < pairs.length; offset += PAIR_BATCH_SIZE) {
    if (grant.floored() || rctx.signal?.aborted) break;
    const batch = pairs
      .slice(offset, offset + PAIR_BATCH_SIZE)
      .filter((pair) => !pair.a.duplicateOf && !pair.b.duplicateOf);
    if (batch.length === 0) continue;
    try {
      const result = await generateObject({
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
          "\n\nReturn one verdict per index: duplicate true or false.",
        schema: verdictSchema,
        maxOutputTokens: JUDGE_MAX_TOKENS,
        maxRetries: MODEL_CALL_MAX_RETRIES,
        abortSignal: rctx.signal,
      });
      for (const verdict of result.object.verdicts) {
        if (!verdict.duplicate) continue;
        const pair = batch[verdict.index];
        if (!pair) continue;
        if (rctx.ledger.merge(pair.b.id, pair.a.id)) merged++;
      }
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
    }
  }
  if (merged > 0) {
    rctx.emit({
      type: "tool.event",
      tool: "dedupe",
      data: { merged, pairsChecked: pairs.length },
    });
  }
  return merged;
}
