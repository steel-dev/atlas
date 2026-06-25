import { afterEach, describe, expect, it, vi } from "vitest";
import { perplexityAgent } from "./perplexity-agent.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("perplexityAgent cost", () => {
  it("computes cost from usage tokens at sonar-deep-research rates", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "answer" } }],
          search_results: [{ url: "https://a", title: "A" }],
          usage: {
            prompt_tokens: 1_000_000,
            completion_tokens: 1_000_000,
            citation_tokens: 1_000_000,
            reasoning_tokens: 1_000_000,
            num_search_queries: 1000,
          },
        }),
        { status: 200 },
      ),
    );
    const agent = perplexityAgent({ apiKey: "k" });
    const result = await agent.research("q", {
      budget: { maxUSD: 1 },
      log: () => {},
    });
    expect(result.report).toBe("answer");
    expect(result.sources[0]?.url).toBe("https://a");
    expect(result.cost).toBeCloseTo(20);
  });

  it("omits cost (rather than reporting $0) when the response has no usage", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "x" } }] }),
        { status: 200 },
      ),
    );
    const agent = perplexityAgent({ apiKey: "k" });
    const result = await agent.research("q", {
      budget: { maxUSD: 1 },
      log: () => {},
    });
    expect(result.cost).toBeUndefined();
  });
});
