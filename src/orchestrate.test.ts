import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.js";
import type { ResolvedModel } from "./model.js";
import { researcher, type Researcher } from "./researcher.js";

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

function leadModel(decomposition: unknown, synth = "MERGED"): ResolvedModel {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return textResult(JSON.stringify(decomposition));
      }
      return textResult(synth);
    },
  }) as unknown as ResolvedModel;
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

const PRICING = { "claude-sonnet-4-6": { inputPerMTok: 0.5, outputPerMTok: 2 } };

describe("orchestrated research (via Atlas)", () => {
  it("decomposes, routes to researchers, synthesizes, and reports real stats", async () => {
    const calls: string[] = [];
    const budgets: number[] = [];
    const atlas = new Atlas({
      model: leadModel(
        {
          strategy: "split into two",
          subtasks: [
            { query: "academic angle", researcher: "exa" },
            { query: "shopping angle", researcher: "web" },
          ],
        },
        "MERGED",
      ),
      researchers: {
        exa: fakeResearcher("EXA", {
          calls,
          budgets,
          sources: [{ url: "https://e", title: "E" }],
        }),
        web: fakeResearcher("WEB", {
          calls,
          budgets,
          sources: [{ url: "https://w", title: "W" }],
        }),
      },
      pricing: PRICING,
    });
    const result = await atlas.research("Q");
    expect(result.report).toBe("MERGED");
    expect([...calls].sort()).toEqual(["academic angle", "shopping angle"]);
    expect(result.sources.map((s) => s.via).sort()).toEqual(["exa", "web"]);
    expect(result.note).toBe("split into two");
    expect(result.stats.costUSD).toBeGreaterThan(0);
    expect(result.stats.stopReason).toBe("completed");
    expect(budgets.every((b) => b > 0)).toBe(true);
  });

  it("returns the sub-report verbatim for a single sub-task (skips synth)", async () => {
    const atlas = new Atlas({
      model: leadModel(
        { strategy: "trivial", subtasks: [{ query: "Q", researcher: "exa" }] },
        "SHOULD_NOT_APPEAR",
      ),
      researchers: { exa: fakeResearcher("SOLO") },
      pricing: PRICING,
    });
    const result = await atlas.research("Q");
    expect(result.report).toBe("SOLO");
  });

  it("drops a failed researcher and surfaces the failure as a warning", async () => {
    const atlas = new Atlas({
      model: leadModel({
        strategy: "two",
        subtasks: [
          { query: "ok", researcher: "good" },
          { query: "boom", researcher: "bad" },
        ],
      }),
      researchers: {
        good: fakeResearcher("GOOD"),
        bad: fakeResearcher("BAD", { fail: true }),
      },
      pricing: PRICING,
    });
    const result = await atlas.research("Q");
    expect(result.report).toBe("GOOD");
    expect(result.warnings.join(" ")).toContain("bad");
    expect(result.warnings.join(" ")).toContain("boom");
  });

  it("streams an orchestrated run through start() (guard relaxed)", async () => {
    const atlas = new Atlas({
      model: leadModel(
        { strategy: "s", subtasks: [{ query: "q", researcher: "exa" }] },
        "X",
      ),
      researchers: { exa: fakeResearcher("ONE") },
      pricing: PRICING,
    });
    const run = atlas.start("Q");
    const types: string[] = [];
    for await (const e of run.events()) types.push(e.type);
    const result = await run.result();
    expect(result.report).toBe("ONE");
    expect(types).toContain("run.completed");
  });
});
