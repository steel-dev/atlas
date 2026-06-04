import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./research.js";
import { resolveRunConfig } from "./config-resolution.js";
import { steel } from "./steel.js";
import type { SearchProvider } from "./search-provider.js";
import { type LanguageModel } from "./model.js";

function fakeLanguageModel(
  provider = "anthropic",
  modelId = "m",
): Exclude<LanguageModel, string> {
  return {
    specificationVersion: "v2",
    provider,
    modelId,
  } as unknown as Exclude<LanguageModel, string>;
}

describe("research source citations", () => {
  it("matches cited URLs with the same normalization used for fetched sources", () => {
    const citations = __testing.reconcileCitations(
      "Evidence from [Example](https://example.com/report?utm_source=newsletter&b=2&a=1#section).",
      [
        {
          url: "https://example.com/report?a=1&b=2",
          title: "Example Report",
        },
      ],
      [{ url: "https://example.com/report?a=1&b=2" }],
    );

    expect(citations.citedSources).toEqual([
      {
        url: "https://example.com/report?a=1&b=2",
        title: "Example Report",
      },
    ]);
    expect(citations.citationsNotConfirmed).toEqual([]);
    expect(citations.citationsNotFetched).toEqual([]);
  });

  it("does not promote unfetched cited URLs into cited sources", () => {
    const citations = __testing.reconcileCitations(
      [
        "Cited evidence from [Fetched](https://example.com/fetched).",
        "Claim citing an unread page [Unfetched](https://example.com/unfetched).",
        "Repeated bare URL should dedupe: https://example.com/unfetched.",
      ].join("\n"),
      [
        {
          url: "https://example.com/fetched",
          title: "Fetched Source",
        },
      ],
      [{ url: "https://example.com/fetched" }],
    );

    expect(citations.citedSources).toEqual([
      {
        url: "https://example.com/fetched",
        title: "Fetched Source",
      },
    ]);
    expect(citations.citationsNotConfirmed).toEqual([]);
    expect(citations.citationsNotFetched).toEqual([
      "https://example.com/unfetched",
    ]);
  });

  it("preserves balanced parentheses in cited URLs", () => {
    const citations = __testing.reconcileCitations(
      [
        "From [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and a bare",
        "https://en.wikipedia.org/wiki/Baz_(qux).",
      ].join(" "),
      [
        { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" },
        { url: "https://en.wikipedia.org/wiki/Baz_(qux)", title: "Baz" },
      ],
      [
        { url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
        { url: "https://en.wikipedia.org/wiki/Baz_(qux)" },
      ],
    );

    expect(citations.citedSources).toEqual([
      { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" },
      { url: "https://en.wikipedia.org/wiki/Baz_(qux)", title: "Baz" },
    ]);
    expect(citations.citationsNotConfirmed).toEqual([]);
    expect(citations.citationsNotFetched).toEqual([]);
  });

  it("flags a fetched source the report cites without a confirmed claim", () => {
    const citations = __testing.reconcileCitations(
      [
        "Rests on [Confirmed](https://example.com/confirmed)",
        "and [Unconfirmed](https://example.com/unconfirmed).",
      ].join(" "),
      [
        { url: "https://example.com/confirmed", title: "Confirmed" },
        { url: "https://example.com/unconfirmed", title: "Unconfirmed" },
      ],
      [{ url: "https://example.com/confirmed" }],
    );

    expect(citations.citedSources).toEqual([
      { url: "https://example.com/confirmed", title: "Confirmed" },
    ]);
    expect(citations.citationsNotConfirmed).toEqual([
      "https://example.com/unconfirmed",
    ]);
    expect(citations.citationsNotFetched).toEqual([]);
  });
});

describe("resolveRunConfig", () => {
  const ATLAS_ENV_KEYS = [
    "ATLAS_TOKEN_LIMIT",
    "ATLAS_MAX_CONCURRENT_MODEL_CALLS",
    "ATLAS_LEAF_MODEL",
    "ATLAS_EXA_API_KEY",
    "EXA_API_KEY",
    "ATLAS_BRAVE_API_KEY",
    "BRAVE_API_KEY",
    "ATLAS_BROWSER_MAX_SESSIONS",
    "ATLAS_BROWSER_IDLE_TTL_MS",
  ];

  function clearAtlasEnv(): void {
    for (const key of ATLAS_ENV_KEYS) vi.stubEnv(key, "");
  }

  afterEach(() => vi.unstubAllEnvs());

  it("derives tool-call and source caps from the token budget", () => {
    clearAtlasEnv();
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "sk" }),
      tokenLimit: 800_000,
    });

    expect(config.agent.tokenLimit).toBe(800_000);
    expect(config.safetyMaxToolCalls).toBe(100);
    expect(config.agent.sourceCap).toBe(80);
    expect(config.maxConcurrentModelCalls).toBe(8);
    expect(config.leafModel).toBe("m");
    expect(config.timeoutDeadlineAt).toBeUndefined();
  });

  it("maps a depth tier onto the token budget", () => {
    clearAtlasEnv();
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "sk" }),
      depth: "quick",
    });

    expect(config.agent.tokenLimit).toBe(500_000);
  });

  it("prefers an explicit tokenLimit over the depth tier", () => {
    clearAtlasEnv();
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "sk" }),
      depth: "deep",
      tokenLimit: 123_000,
    });

    expect(config.agent.tokenLimit).toBe(123_000);
  });

  it("sizes caps from the default budget when tokens are unlimited", () => {
    clearAtlasEnv();
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "sk" }),
      tokenLimit: 0,
    });

    expect(config.agent.tokenLimit).toBe(0);
    expect(config.safetyMaxToolCalls).toBe(250);
    expect(config.agent.sourceCap).toBe(100);
  });

  it("maps the browser provider onto resolved steel config", () => {
    clearAtlasEnv();
    vi.stubEnv("ATLAS_STEEL_API_KEY", "env-steel");
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ proxy: true, baseUrl: "https://steel.local" }),
    });

    // apiKey omitted on the provider still falls back to env — zero-config intact
    expect(config.steelApiKey).toBe("env-steel");
    expect(config.steelBaseUrl).toBe("https://steel.local");
    expect(config.useProxy).toBe(true);
  });

  it("prefers an explicit browser apiKey and defaults proxy off", () => {
    clearAtlasEnv();
    vi.stubEnv("ATLAS_STEEL_API_KEY", "env-steel");
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "explicit" }),
    });

    expect(config.steelApiKey).toBe("explicit");
    expect(config.useProxy).toBe(false);
  });

  it("passes an explicit search provider through to the run config", () => {
    clearAtlasEnv();
    const search: SearchProvider = { name: "fake", searchQuery: vi.fn() };
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "sk" }),
      search,
    });

    expect(config.search).toBe(search);
  });

  it("reserves finalization time from the wall-clock timeout", () => {
    clearAtlasEnv();
    const before = Date.now();
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
      browser: steel({ apiKey: "sk" }),
      timeoutMs: 60_000,
    });

    expect(config.synthesisReserveMs).toBe(15_000);
    expect(config.timeoutDeadlineAt ?? 0).toBeGreaterThanOrEqual(
      before + 60_000,
    );
  });

  it("requires a Steel API key", () => {
    clearAtlasEnv();
    vi.stubEnv("STEEL_API_KEY", "");
    vi.stubEnv("ATLAS_STEEL_API_KEY", "");

    expect(() =>
      resolveRunConfig({
        query: "q",
        model: fakeLanguageModel(),
      }),
    ).toThrow(/STEEL_API_KEY/);
  });

  it("resolves Steel from the environment when no browser is given", () => {
    clearAtlasEnv();
    vi.stubEnv("ATLAS_STEEL_API_KEY", "env-steel");

    // The headline zero-config call: new Atlas({ model }).research(query) with no browser.
    const config = resolveRunConfig({
      query: "q",
      model: fakeLanguageModel(),
    });

    expect(config.steelApiKey).toBe("env-steel");
    expect(config.useProxy).toBe(false);
    expect(config.search).toBeUndefined();
  });
});
