import { afterEach, describe, expect, it, vi } from "vitest";
import { parallelAgent } from "./parallel-agent.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parallelAgent cost", () => {
  it("derives per-run cost from the processor tier", async () => {
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/runs")) {
        return new Response(
          JSON.stringify({ run_id: "r1", status: "completed" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/result")) {
        return new Response(
          JSON.stringify({
            output: {
              content: "res",
              basis: [{ citations: [{ url: "https://p", title: "P" }] }],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), {
        status: 200,
      });
    });
    const agent = parallelAgent({ apiKey: "k", processor: "core" });
    const result = await agent.research("q", {
      budget: { maxUSD: 1 },
      log: () => {},
    });
    expect(result.report).toBe("res");
    expect(result.sources[0]?.url).toBe("https://p");
    expect(result.cost).toBeCloseTo(0.025);
  });

  it("honors an explicit costPerRunUSD override", async () => {
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/result")) {
        return new Response(
          JSON.stringify({ output: { content: "res", basis: [] } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ run_id: "r1", status: "completed" }),
        { status: 200 },
      );
    });
    const agent = parallelAgent({
      apiKey: "k",
      processor: "pro",
      costPerRunUSD: 0.5,
    });
    const result = await agent.research("q", {
      budget: { maxUSD: 1 },
      log: () => {},
    });
    expect(result.cost).toBeCloseTo(0.5);
  });
});
