import { generateText, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
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

  it("reserves estimated cost while a call is in flight", async () => {
    const meter = createBudgetMeter(10);
    let releaseCall!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const inner = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async () => {
        await inFlight;
        return RESULT;
      },
    });
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: meter,
      pricing: { "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 } },
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
    });
    const pending = generateText({
      model: model as LanguageModelV3,
      prompt: "hi",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(meter.remainingUSD()).toBeLessThan(10);
    expect(meter.totalSpentUSD()).toBe(0);
    releaseCall();
    await pending;
    expect(meter.remainingUSD()).toBeCloseTo(7);
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
    const usage2 = createRunUsage();
    const secondModel = engineModel(second as unknown as ResolvedModel, {
      role: "lead",
      grant: meter2,
      pricing: {},
      gate: createConcurrencyGate(2),
      usage: usage2,
      replay,
    });
    const replayed = await generateText({
      model: secondModel as LanguageModelV3,
      prompt: "same question",
    });
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(replayed.text).toBe(liveResult.text);
    expect(meter2.totalSpentUSD()).toBe(meter.totalSpentUSD());
    expect(usage2.replayedUSD).toBe(meter2.totalSpentUSD());
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

describe("engineModel streaming", () => {
  const PRICING = { "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 } };

  function streamingMock(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "hello " },
            { type: "text-delta", id: "t1", delta: "world" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: RESULT.usage,
            },
          ],
        }),
      }),
    });
  }

  it("meters and journals a streamed call", async () => {
    const store = memoryStore();
    const journal = new JournalWriter(store, "run_stream");
    const meter = createBudgetMeter(10);
    const inner = streamingMock();
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "write",
      grant: meter,
      pricing: PRICING,
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
      journal,
    });
    const result = streamText({ model: model as LanguageModelV3, prompt: "hi" });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("hello world");
    expect(meter.totalSpentUSD()).toBeCloseTo(3);
    await journal.flush();

    const replay = await loadReplayCache(store, "run_stream");
    const replayMeter = createBudgetMeter(10);
    const fresh = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
    });
    const replayUsage = createRunUsage();
    const replayModel = engineModel(fresh as unknown as ResolvedModel, {
      role: "write",
      grant: replayMeter,
      pricing: PRICING,
      gate: createConcurrencyGate(2),
      usage: replayUsage,
      replay,
    });
    const replayed = streamText({
      model: replayModel as LanguageModelV3,
      prompt: "hi",
    });
    let replayedText = "";
    for await (const delta of replayed.textStream) replayedText += delta;
    expect(replayedText).toBe("hello world");
    expect(fresh.doStreamCalls).toHaveLength(0);
    expect(replayMeter.totalSpentUSD()).toBeCloseTo(3);
    expect(replayUsage.replayedUSD).toBeCloseTo(3);
  });

  it("charges the reserved estimate when a stream ends without a finish part", async () => {
    const meter = createBudgetMeter(10);
    const inner = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "partial" },
            // connection dropped: no text-end, no finish, no usage report
          ],
        }),
      }),
    });
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "write",
      grant: meter,
      pricing: PRICING,
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
    });
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as Parameters<LanguageModelV3["doStream"]>[0]);
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    const spent = meter.totalSpentUSD();
    expect(spent).toBeGreaterThan(0);
    // the hold is settled, not leaked: remaining reflects only the charge
    expect(meter.remainingUSD()).toBeCloseTo(10 - spent);
  });
});
