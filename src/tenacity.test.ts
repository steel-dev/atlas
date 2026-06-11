import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.js";
import type { ResolvedModel } from "./model.js";
import { memoryStore } from "./providers/store.js";
import type { SearchProvider } from "./providers/search.js";
import type { ResearchEvent } from "./events.js";

const HEAVY_USAGE = {
  inputTokens: { total: 20_000, noCache: 20_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1_000, text: 1_000, reasoning: 0 },
};

const HUGE_CONTEXT_USAGE = {
  inputTokens: {
    total: 200_000,
    noCache: 200_000,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 200, text: 200, reasoning: 0 },
};

const SMALL_USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

type Usage = typeof SMALL_USAGE;

function textResult(text: string, usage: Usage): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

function searchCallResult(
  query: string,
  usage: Usage,
): LanguageModelV3GenerateResult {
  return {
    content: [
      { type: "text", text: `Plan: search for ${query}.` },
      {
        type: "tool-call",
        toolCallId: `call_${query}`,
        toolName: "search",
        input: JSON.stringify({ queries: [query] }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

function lastUserText(options: LanguageModelV3CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const message = options.prompt[i];
    if (message.role !== "user") continue;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function systemText(options: LanguageModelV3CallOptions): string {
  return options.prompt
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .join("\n");
}

function jsonDispatch(
  options: LanguageModelV3CallOptions,
  coverage: () => { answered: boolean; gaps: string[] },
): LanguageModelV3GenerateResult {
  const prompt = lastUserText(options);
  if (prompt.includes("Does this ledger contain")) {
    return textResult(JSON.stringify(coverage()), SMALL_USAGE);
  }
  if (prompt.includes("Return the factual indices")) {
    return textResult(JSON.stringify({ factual: [] }), SMALL_USAGE);
  }
  return textResult(JSON.stringify({ openQuestions: [] }), SMALL_USAGE);
}

const stubSearch: SearchProvider = {
  id: "stub",
  search: async () => [
    {
      position: 1,
      title: "Result",
      url: "https://example.com/answer",
      snippet: "snippet",
      domain: "example.com",
    },
  ],
};

function heavySpendModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return jsonDispatch(options, () => ({ answered: true, gaps: [] }));
      }
      step++;
      if (step === 1) return searchCallResult("alpha", HEAVY_USAGE);
      if (step === 2) return searchCallResult("beta", HEAVY_USAGE);
      return textResult(
        "Research finished; the ledger covers the question.",
        HEAVY_USAGE,
      );
    },
  });
}

describe("resume replay fidelity", () => {
  it("replays a multi-step run with material spend without re-invoking the model", async () => {
    const store = memoryStore();
    const firstModel = heavySpendModel();
    const atlas = new Atlas({
      model: firstModel as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
      budget: { maxUSD: 5 },
    });
    const original = await atlas
      .start("multi step question", { runId: "run_heavy" })
      .result();
    expect(firstModel.doGenerateCalls.length).toBeGreaterThanOrEqual(3);
    expect(original.stats.costUSD).toBeGreaterThan(0.1);

    const replayModel = heavySpendModel();
    const resumed = await Atlas.resume("run_heavy", {
      model: replayModel as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
      budget: { maxUSD: 5 },
    });
    const replayed = await resumed.result();
    expect(replayModel.doGenerateCalls.length).toBe(0);
    expect(replayed.report).toBe(original.report);
    expect(replayed.stats.costUSD).toBe(0);
  });

  it("pins the prompt date to the original run so resume replays across days", async () => {
    const startedAt = Date.UTC(2026, 0, 15, 12, 0, 0);
    const store = memoryStore();
    const firstModel = heavySpendModel();
    const atlas = new Atlas({
      model: firstModel as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
      budget: { maxUSD: 5 },
    });
    await atlas
      .start("dated question", {
        runId: "run_dated",
        now: () => startedAt,
      })
      .result();
    expect(systemText(firstModel.doGenerateCalls[0])).toContain("2026-01-15");

    const replayModel = heavySpendModel();
    const resumed = await Atlas.resume(
      "run_dated",
      {
        model: replayModel as unknown as ResolvedModel,
        search: stubSearch,
        store,
        effort: "fast",
        budget: { maxUSD: 5 },
      },
      { now: () => startedAt + 3 * 86_400_000 },
    );
    await resumed.result();
    expect(replayModel.doGenerateCalls.length).toBe(0);
  });
});

describe("lead re-contexting", () => {
  it("re-anchors the lead in a fresh context when the context budget is hit", async () => {
    let leadCalls = 0;
    const model = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        if (options.responseFormat?.type === "json") {
          return jsonDispatch(options, () => ({ answered: true, gaps: [] }));
        }
        leadCalls++;
        if (leadCalls === 1) {
          return searchCallResult("first pass", HUGE_CONTEXT_USAGE);
        }
        return textResult(
          "Continued in a fresh context; coverage complete.",
          SMALL_USAGE,
        );
      },
    });
    const atlas = new Atlas({
      model: model as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
      budget: { maxUSD: 20 },
    });
    const run = atlas.start("long horizon question");
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(run.status()).toBe("completed");
    expect(leadCalls).toBe(2);
    const recontexted = events.filter(
      (event) => event.type === "lead.recontexted",
    );
    expect(recontexted).toHaveLength(1);
    expect(recontexted[0]).toMatchObject({ session: 2 });
    const continuation = model.doGenerateCalls.find((call) =>
      lastUserText(call).includes("previous context filled up"),
    );
    expect(continuation).toBeDefined();
    expect(lastUserText(continuation!)).toContain("Ledger so far");
    expect(result.note).toContain("fresh context");
  });
});

describe("coverage adjudication", () => {
  it("re-anchors the lead on coverage gaps and stops once answered", async () => {
    let leadCalls = 0;
    let coverageCalls = 0;
    const gap = "Pin down the launch date of the Foo 9 rocket";
    const model = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        if (options.responseFormat?.type === "json") {
          return jsonDispatch(options, () => {
            coverageCalls++;
            return coverageCalls === 1
              ? { answered: false, gaps: [gap] }
              : { answered: true, gaps: [] };
          });
        }
        leadCalls++;
        if (leadCalls === 1) return searchCallResult("initial", SMALL_USAGE);
        if (leadCalls === 2) {
          return textResult("Initial pass done; some gaps remain.", SMALL_USAGE);
        }
        return textResult(
          "Gap addressed; launch date established.",
          SMALL_USAGE,
        );
      },
    });
    const atlas = new Atlas({
      model: model as unknown as ResolvedModel,
      search: stubSearch,
      effort: "deep",
    });
    const run = atlas.start("gap question");
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(run.status()).toBe("completed");
    expect(coverageCalls).toBe(2);
    const assessed = events.filter(
      (event) => event.type === "coverage.assessed",
    );
    expect(assessed).toHaveLength(2);
    expect(assessed[0]).toMatchObject({
      round: 1,
      answered: false,
      gaps: [gap],
    });
    expect(assessed[1]).toMatchObject({ round: 2, answered: true });
    const gapAnchor = model.doGenerateCalls.find((call) =>
      lastUserText(call).includes("Coverage gaps to close"),
    );
    expect(gapAnchor).toBeDefined();
    expect(lastUserText(gapAnchor!)).toContain(gap);
    expect(result.note).toContain("launch date established");
  });
});
