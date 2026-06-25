import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createConcurrencyGate } from "./async.js";
import { createBudgetMeter } from "./budget.js";
import { createRunUsage, engineModel, type ResolvedModel } from "./model.js";
import {
  JournalWriter,
  loadReplayCache,
  memoryStore,
} from "./providers/store.js";
import {
  createTraceRecorder,
  currentFrame,
  toAnthropicBlocks,
  withTraceFrame,
} from "./trace.js";

const USAGE = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
} as const;

const TEXT_RESULT: LanguageModelV3GenerateResult = {
  content: [{ type: "text", text: "hello" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: USAGE,
  warnings: [],
};

const PRICING = { "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 } };

function clock() {
  let t = 0;
  return () => ++t;
}

function recorderFull() {
  return createTraceRecorder({ mode: "full", now: clock(), startedAt: 0 });
}

describe("trace recorder via engineModel", () => {
  it("captures a model span and a verbatim step in full mode", async () => {
    const recorder = recorderFull();
    const model = engineModel(
      new MockLanguageModelV3({
        provider: "mock-provider",
        modelId: "claude-sonnet-4-6",
        doGenerate: TEXT_RESULT,
      }) as unknown as ResolvedModel,
      {
        role: "lead",
        grant: createBudgetMeter(10),
        pricing: PRICING,
        gate: createConcurrencyGate(2),
        usage: createRunUsage(),
        recorder,
      },
    );
    await generateText({ model: model as LanguageModelV3, prompt: "hi" });

    const snap = recorder.snapshot();
    const modelSpans = snap.spans.filter((s) => s.kind === "model");
    expect(modelSpans).toHaveLength(1);
    expect(modelSpans[0].role).toBe("lead");
    expect(modelSpans[0].status).toBe("ok");
    expect(modelSpans[0].attrs?.adapter).toBe(
      "mock-provider:claude-sonnet-4-6",
    );
    expect(modelSpans[0].costUSD).toBeGreaterThan(0);

    expect(snap.steps).toHaveLength(1);
    const step = snap.steps[0];
    expect(step.role).toBe("lead");
    expect(step.output).toContainEqual({ type: "text", text: "hello" });
    expect(Array.isArray(step.messages)).toBe(true);
  });

  it("does nothing when tracing is off (no recorder)", async () => {
    const inner = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: TEXT_RESULT,
    });
    const model = engineModel(inner as unknown as ResolvedModel, {
      role: "lead",
      grant: createBudgetMeter(10),
      pricing: PRICING,
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
    });
    const result = await generateText({
      model: model as LanguageModelV3,
      prompt: "hi",
    });
    expect(result.text).toBe("hello");
    // withTraceFrame is inert without a recorder: the frame is never established
    expect(
      withTraceFrame(undefined, { agentId: "x" }, () => currentFrame()),
    ).toBe(undefined);
  });

  it("attributes each concurrent call to its own agent frame (ALS)", async () => {
    const recorder = recorderFull();
    const seen: Record<string, string | undefined> = {};
    const make = (label: string) =>
      engineModel(
        new MockLanguageModelV3({
          provider: "mock-provider",
          modelId: "claude-sonnet-4-6",
          doGenerate: async () => {
            // survives an await — ALS context must persist across microtasks
            await new Promise((r) => setTimeout(r, 5));
            seen[label] = currentFrame()?.agentId;
            return TEXT_RESULT;
          },
        }) as unknown as ResolvedModel,
        {
          role: "research",
          grant: createBudgetMeter(10),
          pricing: PRICING,
          gate: createConcurrencyGate(4),
          usage: createRunUsage(),
          recorder,
        },
      );

    await Promise.all([
      withTraceFrame(recorder, { agentId: "agent_A" }, () =>
        generateText({ model: make("A") as LanguageModelV3, prompt: "a" }),
      ),
      withTraceFrame(recorder, { agentId: "agent_B" }, () =>
        generateText({ model: make("B") as LanguageModelV3, prompt: "b" }),
      ),
    ]);

    // Each model call observed ITS OWN frame, never the sibling's.
    expect(seen.A).toBe("agent_A");
    expect(seen.B).toBe("agent_B");
    const agents = recorder
      .snapshot()
      .spans.filter((s) => s.kind === "model")
      .map((s) => s.agentId)
      .sort();
    expect(agents).toEqual(["agent_A", "agent_B"]);
  });

  it("represents a replayed call without re-invoking the model", async () => {
    const store = memoryStore();
    const journal = new JournalWriter(store, "run_replay");
    const live = engineModel(
      new MockLanguageModelV3({
        provider: "mock-provider",
        modelId: "claude-sonnet-4-6",
        doGenerate: TEXT_RESULT,
      }) as unknown as ResolvedModel,
      {
        role: "lead",
        grant: createBudgetMeter(10),
        pricing: PRICING,
        gate: createConcurrencyGate(2),
        usage: createRunUsage(),
        journal,
      },
    );
    await generateText({ model: live as LanguageModelV3, prompt: "same" });
    await journal.flush();

    const replay = await loadReplayCache(store, "run_replay");
    const recorder = recorderFull();
    const fresh = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: TEXT_RESULT,
    });
    const replayModel = engineModel(fresh as unknown as ResolvedModel, {
      role: "lead",
      grant: createBudgetMeter(10),
      pricing: PRICING,
      gate: createConcurrencyGate(2),
      usage: createRunUsage(),
      replay,
      recorder,
    });
    await generateText({
      model: replayModel as LanguageModelV3,
      prompt: "same",
    });

    expect(fresh.doGenerateCalls).toHaveLength(0);
    const snap = recorder.snapshot();
    const span = snap.spans.find((s) => s.kind === "model");
    expect(span?.status).toBe("replayed");
    expect(snap.steps[0]?.replayed).toBe(true);
    // verbatim prompt is still reconstructable on replay
    expect(Array.isArray(snap.steps[0]?.messages)).toBe(true);
  });
});

describe("toAnthropicBlocks", () => {
  it("maps SDK content vocabulary to the query renderer's vocabulary", () => {
    const content: LanguageModelV3Content[] = [
      { type: "reasoning", text: "why" },
      { type: "text", text: "answer" },
      {
        type: "tool-call",
        toolCallId: "1",
        toolName: "search",
        input: '{"q":"x"}',
      },
    ];
    expect(toAnthropicBlocks(content)).toEqual([
      { type: "thinking", thinking: "why" },
      { type: "text", text: "answer" },
      { type: "tool_call", name: "search", input: { q: "x" } },
    ]);
  });

  it("returns an empty list for missing content", () => {
    expect(toAnthropicBlocks(undefined)).toEqual([]);
  });
});
