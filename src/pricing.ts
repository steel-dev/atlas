// Relative model cost, used to weight token spend against the run-wide token
// budget. Without this, a cheap leaf model's high-volume calls (claim
// extraction, verifier voters) draw down the budget at the lead model's rate,
// so a tight budget starves verification even though those tokens cost a
// fraction of a lead token. Weighting leaf tokens by their real price lets the
// same budget fund far more cheap leaf work.
//
// Values are USD per 1M input tokens. Only ratios are used here, and across this
// table output price is a fixed multiple of input (and the cache multipliers are
// global), so the input-price ratio is a faithful cost ratio for the whole token
// bucket. If you add a model whose output/input ratio differs, revisit
// modelCostWeight.
const INPUT_USD_PER_MTOK: Record<string, number> = {
  "claude-opus-4-8": 5,
  "claude-opus-4-7": 5,
  "claude-opus-4-6": 5,
  "claude-opus-4-5": 5,
  "claude-sonnet-4-6": 3,
  "claude-sonnet-4-5": 3,
  "claude-haiku-4-5": 1,
};

function priceOf(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  if (INPUT_USD_PER_MTOK[modelId] !== undefined) {
    return INPUT_USD_PER_MTOK[modelId];
  }
  // Strip provider/region prefixes like "us.anthropic." one segment at a time.
  const parts = modelId.split(".");
  for (let i = 1; i < parts.length; i++) {
    const price = INPUT_USD_PER_MTOK[parts.slice(i).join(".")];
    if (price !== undefined) return price;
  }
  return undefined;
}

// How much one of `modelId`'s tokens costs relative to one of
// `referenceModelId`'s, for budget weighting. Returns 1 when either price is
// unknown so an unrecognized model is charged at full (reference) weight — never
// under-counted against the budget.
export function modelCostWeight(
  modelId: string | undefined,
  referenceModelId: string | undefined,
): number {
  const price = priceOf(modelId);
  const reference = priceOf(referenceModelId);
  if (price === undefined || reference === undefined || reference <= 0) {
    return 1;
  }
  return price / reference;
}
