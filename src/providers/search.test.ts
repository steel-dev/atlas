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
});
