import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createConcurrencyGate } from "./async.js";
import { createBudgetMeter } from "./budget.js";
import { createRunUsage, engineModel, type ResolvedModel } from "./model.js";
import {
  JournalWriter,
  loadReplayCache,
  memoryStore,
} from "./providers/store.js";

const RESULT: LanguageModelV3GenerateResult = {
  content: [{ type: "text", text: "hello" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
  warnings: [],
};

function mock(provider = "mock-provider", modelId = "claude-sonnet-4-6") {
  return new MockLanguageModelV3({
    provider,
    modelId,
    doGenerate: RESULT,
  });
}

describe("engineModel", () => {
  it("charges usage cost against the grant", async () => {
    const meter = createBudgetMeter(10);
    const inner = mock();
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: meter,
      pricing: { "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 } },
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
    });
    const result = await generateText({
      model: model as LanguageModelV3,
      prompt: "hi",
    });
    expect(result.text).toBe("hello");
    expect(meter.totalSpentUSD()).toBeCloseTo(3);
  });

  it("tracks usage per role", async () => {
    const usage = createRunUsage();
    const meter = createBudgetMeter(10);
    const model = engineModel(mock() as unknown as ResolvedModel, {
      role: "extract",
      grant: meter,
      pricing: {},
      gate: createConcurrencyGate(2),
      usage,
    });
    await generateText({ model: model as LanguageModelV3, prompt: "hi" });
    expect(usage.byRole.get("extract")?.input).toBe(1_000_000);
  });

  it("journals calls and replays them without re-invoking the model", async () => {
    const store = memoryStore();
    const journal = new JournalWriter(store, "run_1");
    const meter = createBudgetMeter(10);
    const first = mock();
    const firstModel = engineModel(first as unknown as ResolvedModel, {
      role: "lead",
      grant: meter,
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
      journal,
    });
    const liveResult = await generateText({
      model: firstModel as LanguageModelV3,
      prompt: "same question",
    });
    await journal.flush();
    expect(first.doGenerateCalls).toHaveLength(1);

    const replay = await loadReplayCache(store, "run_1");
    const meter2 = createBudgetMeter(10);
    const second = mock();
    const secondModel = engineModel(second as unknown as ResolvedModel, {
      role: "lead",
      grant: meter2,
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
      replay,
    });
    const replayed = await generateText({
      model: secondModel as LanguageModelV3,
      prompt: "same question",
    });
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(replayed.text).toBe(liveResult.text);
    expect(meter2.totalSpentUSD()).toBe(0);
  });

  it("injects an anthropic cache breakpoint on the last message", async () => {
    const inner = mock("anthropic.messages", "claude-sonnet-4-6");
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: createBudgetMeter(10),
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
    });
    await generateText({ model: model as LanguageModelV3, prompt: "hi" });
    const params = inner.doGenerateCalls[0];
    const last = params.prompt[params.prompt.length - 1];
    expect(last.providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  it("leaves non-anthropic prompts untouched", async () => {
    const inner = mock("openai.responses", "gpt-5.5");
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: createBudgetMeter(10),
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
    });
    await generateText({ model: model as LanguageModelV3, prompt: "hi" });
    const params = inner.doGenerateCalls[0];
    const last = params.prompt[params.prompt.length - 1];
    expect(last.providerOptions?.anthropic).toBeUndefined();
  });

  it("retries a retryable failure and reports it via onRateLimit", async () => {
    let calls = 0;
    const inner = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async () => {
        calls++;
        if (calls === 1) {
          throw Object.assign(
            new Error(
              "Number of concurrent connections has exceeded your rate limit",
            ),
            { statusCode: 429, isRetryable: true },
          );
        }
        return RESULT;
      },
    });
    const notices: number[] = [];
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: createBudgetMeter(10),
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
      onRateLimit: (notice) => notices.push(notice.attempt),
    });
    const result = await generateText({
      model: model as LanguageModelV3,
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("hello");
    expect(calls).toBe(2);
    expect(notices).toEqual([1]);
  });

  it("does not retry a non-retryable failure", async () => {
    let calls = 0;
    const inner = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async () => {
        calls++;
        throw Object.assign(new Error("invalid request"), {
          statusCode: 400,
          isRetryable: false,
        });
      },
    });
    const notices: number[] = [];
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: createBudgetMeter(10),
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
      onRateLimit: (notice) => notices.push(notice.attempt),
    });
    await expect(
      generateText({
        model: model as LanguageModelV3,
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toThrow(/invalid request/);
    expect(calls).toBe(1);
    expect(notices).toEqual([]);
  });
});
