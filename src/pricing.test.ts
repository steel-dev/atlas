import { describe, expect, it } from "vitest";
import { modelCostWeight } from "./pricing.js";

describe("modelCostWeight", () => {
  it("weights a cheap leaf model below the lead", () => {
    expect(modelCostWeight("claude-haiku-4-5", "claude-opus-4-8")).toBeCloseTo(
      0.2,
    );
  });

  it("is 1 when leaf and lead are the same model", () => {
    expect(modelCostWeight("claude-opus-4-8", "claude-opus-4-8")).toBe(1);
  });

  it("weights an expensive leaf above the lead", () => {
    expect(modelCostWeight("claude-opus-4-8", "claude-haiku-4-5")).toBeCloseTo(
      5,
    );
  });

  it("strips a provider/region prefix before pricing", () => {
    expect(
      modelCostWeight(
        "us.anthropic.claude-haiku-4-5",
        "anthropic.claude-opus-4-8",
      ),
    ).toBeCloseTo(0.2);
  });

  it("falls back to 1 when either model price is unknown", () => {
    expect(modelCostWeight("mystery-model", "claude-opus-4-8")).toBe(1);
    expect(modelCostWeight("claude-haiku-4-5", "mystery-model")).toBe(1);
    expect(modelCostWeight(undefined, undefined)).toBe(1);
  });
});
