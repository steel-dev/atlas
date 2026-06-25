// ABOUTME: Tests for src/env.ts env-var helpers.
// ABOUTME: Covers detectProxyBaseURL, which feeds startup proxy warnings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProxyBaseURL } from "./env.js";

const PROXY_BASE_URL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of PROXY_BASE_URL_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROXY_BASE_URL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("detectProxyBaseURL", () => {
  it("returns the provider base-url env var that is set", () => {
    const env = {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    };
    expect(detectProxyBaseURL(env)).toEqual(["ANTHROPIC_BASE_URL"]);
  });

  it("returns every set proxy var in canonical order", () => {
    const env = {
      OPENAI_BASE_URL: "https://my.gateway/v1",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    };
    expect(detectProxyBaseURL(env)).toEqual([
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
    ]);
  });

  it("ignores Atlas Z.ai base-url configuration", () => {
    const env = {
      ZAI_BASE_URL: "https://api.z.ai/api/paas/v4",
      ATLAS_ZAI_BASE_URL: "https://api.z.ai/api/paas/v4",
    };
    expect(detectProxyBaseURL(env)).toEqual([]);
  });

  it("can scope checks to providers that inherit base-url vars", () => {
    const env = {
      ANTHROPIC_BASE_URL: "https://anthropic-proxy.example",
      OPENAI_BASE_URL: "https://openai-proxy.example",
    };
    expect(detectProxyBaseURL(env, { providers: ["openai"] })).toEqual([
      "OPENAI_BASE_URL",
    ]);
  });

  it("returns an empty list when no proxy var is set", () => {
    expect(detectProxyBaseURL({})).toEqual([]);
  });

  it("reads process.env when called with no argument (the serve.ts call site)", () => {
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example";
    expect(detectProxyBaseURL()).toEqual(["ANTHROPIC_BASE_URL"]);
  });
});
