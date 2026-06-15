import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.js";
import type { ResolvedModel } from "./model.js";
import { loadRunMeta, memoryStore } from "./providers/store.js";
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

  it("replays the full event history to late subscribers", async () => {
    const atlas = new Atlas({
      model: scriptedModel() as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
    });
    const run = atlas.start("test question", { runId: "run_late_sub" });
    await run.result();

    const events: ResearchEvent[] = [];
    for await (const event of run.events()) events.push(event);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("search.completed");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  it("survives an unrecoverable lead-agent model error with a fallback report", async () => {
    const model = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        if (options.responseFormat?.type === "json") {
          return textResult(JSON.stringify({ openQuestions: [] }));
        }
        throw Object.assign(new Error("unrecoverable lead model error"), {
          statusCode: 400,
          isRetryable: false,
        });
      },
    });
    const atlas = new Atlas({
      model: model as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
    });
    const run = atlas.start("test question", { runId: "run_lead_fail" });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(run.status()).toBe("completed");
    expect(result.report.length).toBeGreaterThan(0);

    const runErrors = events.filter(
      (event): event is Extract<ResearchEvent, { type: "run.error" }> =>
        event.type === "run.error",
    );
    expect(runErrors.some((event) => event.recoverable)).toBe(true);
    expect(
      runErrors.some((event) => /lead agent failed/.test(event.message)),
    ).toBe(true);
    expect(events.map((event) => event.type)).toContain("run.completed");
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
    const resumed = await new Atlas({
      model: replayModel as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
    }).resume("run_replay");
    const replayed = await resumed.result();
    expect(replayModel.doGenerateCalls.length).toBe(0);
    expect(replayed.report).toBe(original.report);
    expect(replayed.stats.costUSD).toBe(0);
  });

  it("refuses to resume a structured run without the schema", async () => {
    const store = memoryStore();
    await store.append("run_structured", [
      {
        seq: 0,
        kind: "meta",
        data: {
          runId: "run_structured",
          question: "q",
          effort: "fast",
          budgetUSD: 0.5,
          outputKind: "structured",
          eventVersion: "3.0",
          startedAt: 0,
        },
      },
    ]);
    await expect(
      new Atlas({
        model: scriptedModel() as unknown as ResolvedModel,
        search: stubSearch,
        store,
      }).resume("run_structured"),
    ).rejects.toThrow(/structured output/);
  });

  it("journals the output kind so resume can enforce it", async () => {
    const store = memoryStore();
    const atlas = new Atlas({
      model: scriptedModel() as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
    });
    await atlas.start("test question", { runId: "run_meta" }).result();
    let outputKind: unknown;
    for await (const entry of store.read("run_meta")) {
      if (entry.kind === "meta") {
        outputKind = (entry.data as { outputKind?: unknown }).outputKind;
        break;
      }
    }
    expect(outputKind).toBe("report");
  });

  it("stops a run gracefully and salvages a result", async () => {
    const model = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        if (options.responseFormat?.type === "json") {
          return textResult(JSON.stringify({ openQuestions: [] }));
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call_${Math.random()}`,
              toolName: "search",
              input: JSON.stringify({ queries: ["test question"] }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: USAGE,
          warnings: [],
        } satisfies LanguageModelV3GenerateResult;
      },
    });
    const atlas = new Atlas({
      model: model as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
    });
    const run = atlas.start("test question");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await run.stop();
    const result = await run.result();
    expect(run.status()).toBe("completed");
    expect(result.report.length).toBeGreaterThan(0);
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

function systemText(options: LanguageModelV3CallOptions): string {
  for (const message of options.prompt) {
    if (message.role === "system") return message.content;
  }
  return "";
}

function spawnResult(n: number): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `spawn_${n}`,
        toolName: "spawn",
        input: JSON.stringify({
          role: "research",
          task: `Investigate facet ${n} of the question.`,
        }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function leadThatSpawns(
  attempts: number,
  captured?: string[],
): MockLanguageModelV3 {
  let leadTurns = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return textResult(JSON.stringify({ openQuestions: [] }));
      }
      if (systemText(options).includes("lead agent")) {
        captured?.push(JSON.stringify(options.prompt));
        leadTurns++;
        return leadTurns <= attempts
          ? spawnResult(leadTurns)
          : textResult("Done spawning; closing the research stage.");
      }
      return textResult("Sub-task complete; nothing further to add.");
    },
  });
}

function leadThatKeepsSearching(): MockLanguageModelV3 {
  let searches = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return textResult(JSON.stringify({ openQuestions: [] }));
      }
      if (systemText(options).includes("lead agent")) {
        searches++;
        return {
          content: [
            { type: "text", text: `Searching round ${searches}.` },
            {
              type: "tool-call",
              toolCallId: `call_${searches}`,
              toolName: "search",
              input: JSON.stringify({ queries: [`angle ${searches}`] }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      return textResult("Synthesis: nothing further. Findings: none.");
    },
  });
}

describe("hard caps", () => {
  it("refuses research spawns once the run-wide agent cap is reached", async () => {
    const prompts: string[] = [];
    const atlas = new Atlas({
      model: leadThatSpawns(6, prompts) as unknown as ResolvedModel,
      search: stubSearch,
      effort: "balanced",
      budget: { maxAgents: 3, maxUSD: 100 },
    });
    const result = await atlas
      .start("test question", { runId: "run_agent_cap" })
      .result();

    expect(result.stats.agentsSpawned).toBe(3);
    expect(result.stats.agentCapReached).toBe(true);
    expect(result.stats.maxDepth).toBe(1);
    expect(
      prompts.some((prompt) =>
        prompt.includes("research-agent cap (3) reached"),
      ),
    ).toBe(true);
  });

  it("stops a runaway research loop once the token cap is reached", async () => {
    const atlas = new Atlas({
      model: leadThatKeepsSearching() as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
      budget: { maxTokens: 3_000, maxUSD: 100 },
    });
    const run = atlas.start("test question", { runId: "run_token_cap" });
    const result = await run.result();

    expect(run.status()).toBe("completed");
    expect(result.stats.tokensExhausted).toBe(true);
    expect(result.stats.budgetExhausted).toBe(false);
    expect(result.stats.searches).toBeGreaterThanOrEqual(1);
    expect(result.stats.searches).toBeLessThan(10);
  });

  it("leaves both flags clear on a run that stays within its caps", async () => {
    const atlas = new Atlas({
      model: scriptedModel() as unknown as ResolvedModel,
      search: stubSearch,
      effort: "fast",
    });
    const result = await atlas
      .start("test question", { runId: "run_no_cap" })
      .result();

    expect(result.stats.tokensExhausted).toBe(false);
    expect(result.stats.agentCapReached).toBe(false);
  });

  it("journals the token and agent caps and restores them on resume", async () => {
    const store = memoryStore();
    const atlas = new Atlas({
      model: scriptedModel() as unknown as ResolvedModel,
      search: stubSearch,
      store,
      effort: "fast",
      budget: { maxAgents: 7, maxTokens: 1_234_567, maxUSD: 100 },
    });
    await atlas.start("test question", { runId: "run_meta_caps" }).result();

    const meta = await loadRunMeta(store, "run_meta_caps");
    expect(meta?.maxAgents).toBe(7);
    expect(meta?.maxTokens).toBe(1_234_567);

    const resumed = await atlas.resume("run_meta_caps");
    const replayed = await resumed.result();
    expect(replayed.runId).toBe("run_meta_caps");
  });
});
