import { describe, expect, it } from "vitest";
import {
  researchBudgetExhaustedReason,
  tokenBudgetExhaustedReason,
  type ResearchCtx,
} from "./runtime.js";
import { emptyUsageSummary, type ModelAdapter } from "./model.js";

function adapterWithTokens(outputTokens: number): ModelAdapter {
  return {
    provider: "anthropic",
    model: "test-model",
    usage: { ...emptyUsageSummary(), output_tokens: outputTokens },
    step: async () => {
      throw new Error("step is not exercised in budget tests");
    },
  };
}

function budgetCtx(opts: {
  tokenLimit: number;
  model: ModelAdapter;
  leafModel?: ModelAdapter;
}): ResearchCtx {
  return {
    config: { tokenLimit: opts.tokenLimit },
    deps: { model: opts.model, leafModel: opts.leafModel },
  } as unknown as ResearchCtx;
}

describe("tokenBudgetExhaustedReason", () => {
  it("returns null when no token limit is set", () => {
    const model = adapterWithTokens(10_000);
    expect(
      tokenBudgetExhaustedReason(budgetCtx({ tokenLimit: 0, model })),
    ).toBeNull();
  });

  it("does not double-count when the leaf shares the lead adapter", () => {
    const model = adapterWithTokens(1000);
    const ctx = budgetCtx({ tokenLimit: 1500, model, leafModel: model });
    expect(tokenBudgetExhaustedReason(ctx)).toBeNull();
  });

  it("sums a distinct leaf adapter into the budget", () => {
    const model = adapterWithTokens(600);
    const leafModel = adapterWithTokens(600);
    const ctx = budgetCtx({ tokenLimit: 1000, model, leafModel });
    expect(tokenBudgetExhaustedReason(ctx)).toBe("token budget exhausted");
  });

  it("trips the budget on leaf spend alone while the lead is idle", () => {
    const model = adapterWithTokens(0);
    const leafModel = adapterWithTokens(2000);
    const ctx = budgetCtx({ tokenLimit: 1000, model, leafModel });
    expect(tokenBudgetExhaustedReason(ctx)).toBe("token budget exhausted");
  });

  it("weights a cheap leaf model's tokens by its cost relative to the lead", () => {
    // Haiku tokens cost ~0.2x opus, so 2000 leaf tokens draw down only ~400 of
    // the budget — under 1000, where equal weighting would have exhausted it.
    const model: ModelAdapter = {
      ...adapterWithTokens(0),
      model: "claude-opus-4-8",
    };
    const leafModel: ModelAdapter = {
      ...adapterWithTokens(2000),
      model: "claude-haiku-4-5",
    };
    const ctx = budgetCtx({ tokenLimit: 1000, model, leafModel });
    expect(tokenBudgetExhaustedReason(ctx)).toBeNull();
  });
});

describe("researchBudgetExhaustedReason", () => {
  it("returns null when no token limit is set", () => {
    const model = adapterWithTokens(10_000);
    expect(
      researchBudgetExhaustedReason(budgetCtx({ tokenLimit: 0, model })),
    ).toBeNull();
  });

  it("reserves a verify slice: stops research before the full limit", () => {
    const model = adapterWithTokens(900);
    const ctx = budgetCtx({ tokenLimit: 1000, model });
    expect(researchBudgetExhaustedReason(ctx)).toBe("research budget exhausted");
    expect(tokenBudgetExhaustedReason(ctx)).toBeNull();
  });

  it("keeps research running below the reserve threshold", () => {
    const model = adapterWithTokens(700);
    const ctx = budgetCtx({ tokenLimit: 1000, model });
    expect(researchBudgetExhaustedReason(ctx)).toBeNull();
  });
});
