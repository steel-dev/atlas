import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { runOrchestrated } from "./orchestrate.js";
import { researcher, type Researcher } from "./researcher.js";
import type { AtlasConfig } from "./config.js";

const USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function leadModel(decomposition: unknown, synth = "INTEGRATED"): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return textResult(JSON.stringify(decomposition));
      }
      return textResult(synth);
    },
  });
}

function fakeResearcher(
  report: string,
  opts: {
    calls?: string[];
    budgets?: number[];
    sources?: { url: string; title?: string }[];
    fail?: boolean;
  } = {},
): Researcher {
  return researcher({
    describe: `researcher for ${report}`,
    research: async (query, ctx) => {
      opts.calls?.push(query);
      opts.budgets?.push(ctx.budget.maxUSD);
      if (opts.fail) throw new Error("researcher boom");
      return {
        report,
        sources: opts.sources ?? [{ url: `https://x/${report}`, title: report }],
        cost: 0.1,
        confidence: 0.9,
      };
    },
  });
}

function cfg(model: MockLanguageModelV3): AtlasConfig {
  return { model };
}

describe("runOrchestrated", () => {
  it("decomposes, routes, dispatches in isolation, and synthesizes over reports", async () => {
    const calls: string[] = [];
    const researchers = {
      atlas: fakeResearcher("ATLAS", { calls, sources: [{ url: "https://a", title: "A" }] }),
      exa: fakeResearcher("EXA", { calls, sources: [{ url: "https://e", title: "E" }] }),
    };
    const model = leadModel(
      {
        strategy: "split into two",
        subtasks: [
          { query: "academic angle", researcher: "atlas" },
          { query: "shopping angle", researcher: "exa" },
        ],
      },
      "MERGED",
    );
    const result = await runOrchestrated(cfg(model), "Q", {}, researchers);
    expect(result.report).toBe("MERGED");
    expect([...calls].sort()).toEqual(["academic angle", "shopping angle"]);
    expect(result.sources.map((s) => s.via).sort()).toEqual(["atlas", "exa"]);
    expect(result.stats.sourcesFetched).toBe(2);
    expect(result.note).toBe("split into two");
  });

  it("returns the sub-report verbatim for a single sub-task (skips the synth pass)", async () => {
    const researchers = { atlas: fakeResearcher("SOLO") };
    const model = leadModel(
      { strategy: "trivial", subtasks: [{ query: "Q", researcher: "atlas" }] },
      "SHOULD_NOT_APPEAR",
    );
    const result = await runOrchestrated(cfg(model), "Q", {}, researchers);
    expect(result.report).toBe("SOLO");
  });

  it("drops a failed researcher and reports the failure", async () => {
    const researchers = {
      atlas: fakeResearcher("GOOD"),
      exa: fakeResearcher("BAD", { fail: true }),
    };
    const model = leadModel({
      strategy: "two",
      subtasks: [
        { query: "ok", researcher: "atlas" },
        { query: "boom", researcher: "exa" },
      ],
    });
    const result = await runOrchestrated(cfg(model), "Q", {}, researchers);
    expect(result.report).toBe("GOOD");
    expect(result.warnings.join(" ")).toContain("exa");
    expect(result.warnings.join(" ")).toContain("boom");
    expect(result.unsupportedSentences).toEqual([]);
  });

  it("routes an unknown researcher key to the default atlas researcher", async () => {
    const calls: string[] = [];
    const researchers = { atlas: fakeResearcher("FALLBACK", { calls }) };
    const model = leadModel({
      strategy: "x",
      subtasks: [{ query: "q1", researcher: "ghost" }],
    });
    const result = await runOrchestrated(cfg(model), "Q", {}, researchers);
    expect(calls).toEqual(["q1"]);
    expect(result.report).toBe("FALLBACK");
  });

  it("slices the budget into equal isolated shares per researcher", async () => {
    const budgets: number[] = [];
    const researchers = {
      atlas: fakeResearcher("A", { budgets }),
      exa: fakeResearcher("B", { budgets }),
    };
    const model = leadModel({
      strategy: "s",
      subtasks: [
        { query: "1", researcher: "atlas" },
        { query: "2", researcher: "exa" },
      ],
    });
    await runOrchestrated(cfg(model), "Q", { budget: { maxUSD: 10 } }, researchers);
    expect(budgets).toEqual([4, 4]);
  });
});
