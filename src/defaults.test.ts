import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  DEFAULT_ANTHROPIC_SMALL_MODEL,
  DEFAULT_OPENAI_SMALL_MODEL,
  deriveSmallModel,
} from "./defaults.js";
import { resolveRunConfig } from "./config.js";
import type { ResolvedModel } from "./model.js";

const ENV_KEYS = [
  "ATLAS_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "ATLAS_OPENAI_API_KEY",
  "OPENAI_API_KEY",
];

function fakeModel(provider: string, modelId: string): ResolvedModel {
  return {
    specificationVersion: "v3",
    provider,
    modelId,
  } as unknown as ResolvedModel;
}

function modelId(model: ResolvedModel): string {
  return (model as LanguageModelV3).modelId;
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("deriveSmallModel", () => {
  it("derives a haiku sibling for anthropic leads when a key is present", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const derived = deriveSmallModel(
      fakeModel("anthropic.messages", "claude-opus-4-8"),
    );
    expect(derived).toBeDefined();
    expect(modelId(derived!)).toBe(DEFAULT_ANTHROPIC_SMALL_MODEL);
  });

  it("derives a mini sibling for openai leads when a key is present", () => {
    process.env.OPENAI_API_KEY = "test-key";
    const derived = deriveSmallModel(
      fakeModel("openai.responses", "gpt-5.5"),
    );
    expect(derived).toBeDefined();
    expect(modelId(derived!)).toBe(DEFAULT_OPENAI_SMALL_MODEL);
  });

  it("returns undefined without a provider key in the environment", () => {
    expect(
      deriveSmallModel(fakeModel("anthropic.messages", "claude-opus-4-8")),
    ).toBeUndefined();
    expect(
      deriveSmallModel(fakeModel("openai.responses", "gpt-5.5")),
    ).toBeUndefined();
  });

  it("returns undefined for unrecognized providers", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(
      deriveSmallModel(fakeModel("google.generative-ai", "gemini-2.5-pro")),
    ).toBeUndefined();
  });

  it("returns undefined when the lead is already a small model", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(
      deriveSmallModel(fakeModel("anthropic.messages", "claude-haiku-4-5")),
    ).toBeUndefined();
  });
});

describe("resolveRunConfig model routing", () => {
  it("defaults extract and verify to the derived small model", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const resolved = resolveRunConfig({ model: lead }, {});
    expect(modelId(resolved.models.extract)).toBe(
      DEFAULT_ANTHROPIC_SMALL_MODEL,
    );
    expect(modelId(resolved.models.verify)).toBe(
      DEFAULT_ANTHROPIC_SMALL_MODEL,
    );
    expect(resolved.models.lead).toBe(lead);
    expect(resolved.models.research).toBe(lead);
    expect(resolved.models.write).toBe(lead);
  });

  it("falls back to the lead model when no key allows derivation", () => {
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const resolved = resolveRunConfig({ model: lead }, {});
    expect(resolved.models.extract).toBe(lead);
    expect(resolved.models.verify).toBe(lead);
  });

  it("respects explicit role overrides over derivation", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const lead = fakeModel("anthropic.messages", "claude-opus-4-8");
    const extract = fakeModel("anthropic.messages", "claude-sonnet-4-6");
    const resolved = resolveRunConfig(
      { model: lead, models: { extract } },
      {},
    );
    expect(resolved.models.extract).toBe(extract);
    expect(resolved.models.verify).toBe(extract);
  });
});
