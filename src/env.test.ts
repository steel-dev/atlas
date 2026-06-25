// ABOUTME: Tests for src/env.ts env-var helpers.
// ABOUTME: Covers detectProxyBaseURL, which feeds the serve.ts startup proxy warning.
import { describe, expect, it } from "vitest";
import { detectProxyBaseURL } from "./env.js";

describe("detectProxyBaseURL", () => {
  it("returns the provider base-url env var that is set", () => {
    const env = {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    };
    expect(detectProxyBaseURL(env)).toEqual(["ANTHROPIC_BASE_URL"]);
  });

  it("returns every set proxy var in canonical order", () => {
    const env = {
      ZAI_BASE_URL: "https://api.z.ai/api/paas/v4",
      OPENAI_BASE_URL: "https://my.gateway/v1",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    };
    expect(detectProxyBaseURL(env)).toEqual([
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "ZAI_BASE_URL",
    ]);
  });

  it("returns an empty list when no proxy var is set", () => {
    expect(detectProxyBaseURL({})).toEqual([]);
  });

  it("reads process.env when called with no argument (the serve.ts call site)", () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example";
    try {
      expect(detectProxyBaseURL()).toEqual(["ANTHROPIC_BASE_URL"]);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  });
});
