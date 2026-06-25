import { describe, expect, it } from "vitest";
import { resolveRunConfig } from "./config.js";
import type { ResolvedModel } from "./model.js";

function fakeModel(provider: string, modelId: string): ResolvedModel {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
  } as unknown as ResolvedModel;
}

describe("resolveRunConfig model routing", () => {
  it("defaults every role to the lead model", () => {
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const resolved = resolveRunConfig({ model: lead }, {});
    expect(resolved.models.lead).toBe(lead);
    expect(resolved.models.research).toBe(lead);
    expect(resolved.models.write).toBe(lead);
  });

  it("respects explicit role overrides", () => {
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const research = fakeModel("anthropic.messages", "claude-sonnet-4-6");
    const resolved = resolveRunConfig(
      { model: lead, models: { research } },
      {},
    );
    expect(resolved.models.research).toBe(research);
    expect(resolved.models.lead).toBe(lead);
  });
});

describe("resolveRunConfig hard caps", () => {
  it("defaults the token cap to the effort envelope", () => {
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const balanced = resolveRunConfig({ model: lead }, { effort: "balanced" });
    expect(balanced.maxTokens).toBe(1_000_000);
    const max = resolveRunConfig({ model: lead }, { effort: "max" });
    expect(max.maxTokens).toBe(16_000_000);
  });

  it("lets budget overrides replace the envelope caps", () => {
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const resolved = resolveRunConfig(
      { model: lead },
      { effort: "deep", budget: { maxTokens: 5_000_000 } },
    );
    expect(resolved.maxTokens).toBe(5_000_000);
  });

  it("rejects non-positive cap overrides", () => {
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    expect(() =>
      resolveRunConfig({ model: lead }, { budget: { maxTokens: 0 } }),
    ).toThrow(/maxTokens/);
  });
});
