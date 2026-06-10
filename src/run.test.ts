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

function scriptedModel(): MockLanguageModelV3 {
  let searchIssued = false;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return textResult(JSON.stringify({ openQuestions: [] }));
      }
      if (!searchIssued) {
        searchIssued = true;
        return {
          content: [
            {
              type: "text",
              text: "Plan: answer inline with one search, nothing to spawn.",
            },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "search",
              input: JSON.stringify({ queries: ["test question"] }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      return textResult(
        "The ledger is empty; nothing further to research. Open question: none.",
      );
    },
  });
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

describe("startRun end to end", () => {
  it("runs a single-agent research loop against a scripted model", async () => {
    const store = memoryStore();
    const model = scriptedModel();
    const atlas = new Atlas({
      model: model as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
    });
    const run = atlas.start("test question", { runId: "run_e2e" });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(run.status()).toBe("completed");
    expect(result.runId).toBe("run_e2e");
    expect(result.report).toContain("Findings");
    expect(result.stats.singleAgent).toBe(true);
    expect(result.stats.searches).toBe(1);
    expect(result.stats.costUSD).toBeGreaterThan(0);
    expect(result.note).toContain("ledger is empty");

    const types = events.map((event) => event.type);
    expect(types).toContain("run.started");
    expect(types).toContain("plan.updated");
    expect(types).toContain("search.completed");
    expect(types).toContain("run.completed");
  });

  it("resumes a completed run entirely from the journal replay", async () => {
    const store = memoryStore();
    const firstModel = scriptedModel();
    const atlas = new Atlas({
      model: firstModel as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
    });
    const original = await atlas
      .start("test question", { runId: "run_replay" })
      .result();
    const liveCalls = firstModel.doGenerateCalls.length;
    expect(liveCalls).toBeGreaterThan(0);

    const replayModel = scriptedModel();
    const resumed = await Atlas.resume("run_replay", {
      model: replayModel as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
    });
    const replayed = await resumed.result();
    expect(replayModel.doGenerateCalls.length).toBe(0);
    expect(replayed.report).toBe(original.report);
    expect(replayed.stats.costUSD).toBe(0);
  });

  it("cancels a run via the handle", async () => {
    const model = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        options.abortSignal?.throwIfAborted();
        return textResult("done");
      },
    });
    const atlas = new Atlas({
      model: model as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
    });
    const run = atlas.start("test question");
    await run.cancel();
    await expect(run.result()).rejects.toThrow(/cancelled/);
    expect(run.status()).toBe("cancelled");
  });
});
