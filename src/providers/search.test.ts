import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  combineSearchProviders,
  mergeSearchResults,
  nativeModelSearch,
  type SearchProvider,
  type SearchResult,
} from "./search.js";

function result(position: number, url: string): SearchResult {
  return {
    position,
    title: `Result ${position}`,
    url,
    snippet: "",
    domain: new URL(url).hostname,
  };
}

describe("mergeSearchResults", () => {
  it("boosts urls surfaced by multiple providers", () => {
    const merged = mergeSearchResults(
      [
        {
          provider: "a",
          results: [result(1, "https://x.com/1"), result(2, "https://x.com/2")],
        },
        {
          provider: "b",
          results: [result(1, "https://x.com/2"), result(2, "https://x.com/3")],
        },
      ],
      10,
    );
    expect(merged[0].url).toBe("https://x.com/2");
    expect(merged[0].providers).toEqual(["a", "b"]);
    expect(merged).toHaveLength(3);
  });

  it("dedupes urls that normalize identically", () => {
    const merged = mergeSearchResults(
      [
        {
          provider: "a",
          results: [
            result(1, "https://x.com/page?utm_source=foo"),
            result(2, "https://x.com/page"),
          ],
        },
      ],
      10,
    );
    expect(merged).toHaveLength(1);
  });
});

describe("combineSearchProviders", () => {
  it("collects warnings from failing providers and results from healthy ones", async () => {
    const healthy: SearchProvider = {
      id: "ok",
      search: async () => [result(1, "https://x.com/1")],
    };
    const broken: SearchProvider = {
      id: "broken",
      search: async () => {
        throw new Error("quota exceeded");
      },
    };
    const combined = combineSearchProviders([healthy, broken]);
    const { merged, warnings } = await combined.run({ query: "q" });
    expect(merged).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken");
  });

  it("retries a transient rate-limit error rather than swallowing it as empty", async () => {
    let attempts = 0;
    const flaky: SearchProvider = {
      id: "flaky",
      search: async () => {
        attempts++;
        if (attempts < 2) throw new Error("exa: too many requests");
        return [result(1, "https://x.com/1")];
      },
    };
    const combined = combineSearchProviders([flaky]);
    const { merged, warnings } = await combined.run({ query: "q" });
    expect(attempts).toBe(2);
    expect(merged).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it("does not retry a non-retryable error", async () => {
    let attempts = 0;
    const broken: SearchProvider = {
      id: "broken",
      search: async () => {
        attempts++;
        throw new Error("invalid api key");
      },
    };
    const combined = combineSearchProviders([broken]);
    const { merged, warnings } = await combined.run({ query: "q" });
    expect(attempts).toBe(1);
    expect(merged).toHaveLength(0);
    expect(warnings[0]).toContain("broken");
  });

  it("stops retrying once the query signal is aborted", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const flaky: SearchProvider = {
      id: "flaky",
      search: async () => {
        attempts++;
        controller.abort();
        throw new Error("rate limit");
      },
    };
    const combined = combineSearchProviders([flaky]);
    const { warnings } = await combined.run({
      query: "q",
      signal: controller.signal,
    });
    expect(attempts).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});

describe("nativeModelSearch", () => {
  it("does not map Z.ai GLM models to OpenAI native web search", async () => {
    const provider = nativeModelSearch({
      model: {
        specificationVersion: "v3",
        provider: "openai.chat",
        modelId: "glm-5.2",
      } as Parameters<typeof nativeModelSearch>[0]["model"],
    });

    await expect(provider.search({ query: "z.ai" })).rejects.toThrow(
      /configure a search adapter/,
    );
  });

  it("parses url :: summary lines from text when no structured sources are returned", async () => {
    const result: LanguageModelV3GenerateResult = {
      content: [
        {
          type: "text",
          text:
            "https://example.com/a :: First page about the topic\n" +
            "https://example.org/b :: Second page with more detail",
        },
      ],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    };
    const model = new MockLanguageModelV3({
      provider: "openai",
      modelId: "gpt-test",
      doGenerate: async () => result,
    });

    const provider = nativeModelSearch({
      model: model as unknown as Parameters<
        typeof nativeModelSearch
      >[0]["model"],
    });
    const results = await provider.search({ query: "topic", maxResults: 10 });

    expect(results.map((r) => r.url)).toEqual([
      "https://example.com/a",
      "https://example.org/b",
    ]);
    expect(results[0].snippet).toBe("First page about the topic");
  });
});
