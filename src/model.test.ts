import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  totalUsageTokens,
  wrapModelAdapterWithConcurrency,
  type ModelAdapter,
  type ModelMessage,
  type ModelRetryInfo,
  type ModelStepInput,
  type ModelStepResult,
} from "./model.js";
import {
  createAdaptiveConcurrencyGate,
  type AdaptiveConcurrencyGate,
} from "./runtime.js";

function rateLimitError(message: string): Error {
  const err = new Error(message);
  (err as { status?: number }).status = 429;
  return err;
}

function fakeAdapter(
  step: (input: ModelStepInput) => Promise<ModelStepResult>,
): ModelAdapter {
  return {
    provider: "anthropic",
    model: "test-model",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    step,
  };
}

const STEP_INPUT: ModelStepInput = {
  system: "system",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 16,
};

describe("createAdaptiveConcurrencyGate", () => {
  it("halves on throttle and grows back toward the ceiling on relax", () => {
    const gate = createAdaptiveConcurrencyGate(4);
    expect(gate.limit).toBe(4);

    gate.throttle();
    expect(gate.limit).toBe(2);
    gate.throttle();
    expect(gate.limit).toBe(1);
    gate.throttle();
    expect(gate.limit).toBe(1);

    // Additive increase: needs `current` clean successes to bump each step.
    gate.relax();
    expect(gate.limit).toBe(2);
    gate.relax();
    gate.relax();
    expect(gate.limit).toBe(3);
    gate.relax();
    gate.relax();
    gate.relax();
    expect(gate.limit).toBe(4);

    // Never grows past the ceiling.
    gate.relax();
    gate.relax();
    gate.relax();
    gate.relax();
    expect(gate.limit).toBe(4);
  });

  it("never admits more than the live limit concurrently", async () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const gate = createAdaptiveConcurrencyGate(2);
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const task = () =>
      gate.run(
        () =>
          new Promise<void>((resolve) => {
            active++;
            peak = Math.max(peak, active);
            release.push(() => {
              active--;
              resolve();
            });
          }),
      );

    const running = Promise.all([task(), task(), task(), task()]);
    await flush();
    expect(active).toBe(2);
    while (release.length > 0) {
      release.shift()?.();
      await flush();
    }
    await running;
    expect(peak).toBe(2);
  });
});

describe("wrapModelAdapterWithConcurrency resilience", () => {
  let gate: AdaptiveConcurrencyGate;
  let retries: ModelRetryInfo[];

  beforeEach(() => {
    vi.useFakeTimers();
    gate = createAdaptiveConcurrencyGate(4);
    retries = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a concurrent-connections 429, throttles the gate, then succeeds", async () => {
    let calls = 0;
    const adapter = wrapModelAdapterWithConcurrency(
      fakeAdapter(async () => {
        calls++;
        if (calls <= 2) {
          throw rateLimitError(
            "429 Number of concurrent connections has exceeded your rate limit",
          );
        }
        return { content: [{ type: "text", text: "ok" }] };
      }),
      gate,
      { onRetry: (info) => retries.push(info) },
    );

    const result = adapter.step(STEP_INPUT);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });

    expect(calls).toBe(3);
    expect(retries).toHaveLength(2);
    expect(retries.every((info) => info.concurrency)).toBe(true);
    // Two concurrency throttles (4 -> 2 -> 1); the recovering success relaxes
    // once (1 -> 2), so the gate settles just above the floor it found.
    expect(gate.limit).toBe(2);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    const badRequest = new Error("400 invalid request");
    (badRequest as { status?: number }).status = 400;
    const adapter = wrapModelAdapterWithConcurrency(
      fakeAdapter(async () => {
        calls++;
        throw badRequest;
      }),
      gate,
      { onRetry: (info) => retries.push(info) },
    );

    await expect(adapter.step(STEP_INPUT)).rejects.toBe(badRequest);
    expect(calls).toBe(1);
    expect(retries).toHaveLength(0);
    expect(gate.limit).toBe(4);
  });

  it("gives up after the max attempts and rethrows", async () => {
    let calls = 0;
    const adapter = wrapModelAdapterWithConcurrency(
      fakeAdapter(async () => {
        calls++;
        throw rateLimitError("429 rate limit exceeded");
      }),
      gate,
      { onRetry: (info) => retries.push(info) },
    );

    const result = adapter.step(STEP_INPUT);
    const assertion = expect(result).rejects.toThrow(/rate limit/i);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await assertion;
    expect(calls).toBe(8);
    expect(retries).toHaveLength(7);
  });
});

describe("totalUsageTokens", () => {
  it("sums fresh input, output, and both cache legs", () => {
    expect(
      totalUsageTokens({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 1000,
      }),
    ).toBe(1125);
  });
});

describe("model message mapping (Atlas <-> AI SDK)", () => {
  it("maps a tool-call transcript and recovers tool names for results", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Research question: what changed?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_1",
            name: "search",
            input: { query: "atlas research" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_call_id: "call_1",
            content: '{"results":[]}',
          },
        ],
      },
    ];

    expect(__testing.toAiMessages(messages)).toMatchObject([
      { role: "user", content: "Research question: what changed?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "search",
            input: { query: "atlas research" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "search",
            output: { type: "text", value: '{"results":[]}' },
          },
        ],
      },
    ]);
  });

  it("marks an errored tool result as error-text", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "fetch", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_call_id: "c1",
            content: "boom",
            is_error: true,
          },
        ],
      },
    ];
    const out = __testing.toAiMessages(messages);
    const toolMsg = out.find((m) => m.role === "tool") as {
      content: Array<{ output: { type: string; value: string } }>;
    };
    expect(toolMsg.content[0].output).toEqual({
      type: "error-text",
      value: "boom",
    });
  });
});

describe("reasoning round-trip (signature preservation)", () => {
  it("sends thinking blocks back with their anthropic signature", () => {
    const message: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Outline the clues first.",
          signature: "sig-1",
        },
        {
          type: "tool_call",
          id: "call_1",
          name: "search",
          input: { queries: ["clue"] },
        },
      ],
    };

    expect(__testing.toAiMessages([message])).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Outline the clues first.",
            providerOptions: { anthropic: { signature: "sig-1" } },
          },
          { type: "tool-call", toolCallId: "call_1", toolName: "search" },
        ],
      },
    ]);
  });

  it("reads reasoning + signature back out of a response, preserving order", () => {
    const blocks = __testing.fromAiContent([
      {
        type: "reasoning",
        text: "Outline the clues first.",
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
      { type: "text", text: "the answer" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "search",
        input: { q: 1 },
      },
    ] as unknown as Parameters<typeof __testing.fromAiContent>[0]);

    expect(blocks).toMatchObject([
      {
        type: "thinking",
        thinking: "Outline the clues first.",
        signature: "sig-1",
      },
      { type: "text", text: "the answer" },
      { type: "tool_call", id: "call_1", name: "search", input: { q: 1 } },
    ]);
  });

  it("round-trips a signature through read-then-send unchanged", () => {
    const blocks = __testing.fromAiContent([
      {
        type: "reasoning",
        text: "weigh it",
        providerMetadata: { anthropic: { signature: "sig-xyz" } },
      },
    ] as unknown as Parameters<typeof __testing.fromAiContent>[0]);

    expect(__testing.toAiMessages([{ role: "assistant", content: blocks }])[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "weigh it",
          providerOptions: { anthropic: { signature: "sig-xyz" } },
        },
      ],
    });
  });

  it("preserves redacted reasoning", () => {
    const blocks = __testing.fromAiContent([
      {
        type: "reasoning",
        text: "",
        providerMetadata: { anthropic: { redactedData: "redacted-xyz" } },
      },
    ] as unknown as Parameters<typeof __testing.fromAiContent>[0]);

    expect(blocks).toMatchObject([
      { type: "redacted_thinking", data: "redacted-xyz" },
    ]);
  });
});

describe("usage mapping", () => {
  it("splits Anthropic input tokens into fresh / cache-read / cache-write", () => {
    expect(
      __testing.fromAiUsage({
        inputTokens: 1000,
        inputTokenDetails: {
          noCacheTokens: 200,
          cacheReadTokens: 700,
          cacheWriteTokens: 100,
        },
        outputTokens: 50,
        outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
        totalTokens: 1050,
      } as unknown as Parameters<typeof __testing.fromAiUsage>[0]),
    ).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 700,
    });
  });

  it("derives non-cached input from cachedInputTokens when details are absent", () => {
    expect(
      __testing.fromAiUsage({
        inputTokens: 100,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 10,
        outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
        totalTokens: 110,
        cachedInputTokens: 30,
      } as unknown as Parameters<typeof __testing.fromAiUsage>[0]),
    ).toEqual({
      input_tokens: 70,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30,
    });
  });
});

describe("buildProviderOptions", () => {
  it("emits anthropic thinking + effort for anthropic", () => {
    expect(
      __testing.buildProviderOptions("max", "anthropic", "claude-opus-4-8"),
    ).toEqual({
      anthropic: { thinking: { type: "adaptive" }, effort: "max" },
    });
  });

  it("maps openai reasoning effort for reasoning models (max -> xhigh)", () => {
    expect(__testing.buildProviderOptions("max", "openai", "gpt-5.5")).toEqual({
      openai: { reasoningEffort: "xhigh" },
    });
    expect(__testing.buildProviderOptions("high", "openai", "o3")).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("omits reasoning effort for non-reasoning / compatible openai models", () => {
    expect(
      __testing.buildProviderOptions("high", "openai", "gpt-4o"),
    ).toBeUndefined();
    expect(
      __testing.buildProviderOptions("max", "openai", "llama-3.1-70b-instruct"),
    ).toBeUndefined();
    expect(
      __testing.buildProviderOptions("high", "openai", "qwen2.5-72b"),
    ).toBeUndefined();
  });

  it("returns undefined when no effort is set", () => {
    expect(
      __testing.buildProviderOptions(undefined, "anthropic", "claude-opus-4-8"),
    ).toBeUndefined();
  });
});

describe("isOpenAiReasoningModel", () => {
  it("matches OpenAI reasoning families", () => {
    for (const id of ["o1", "o3", "o3-mini", "o4-mini", "gpt-5", "gpt-5.5"]) {
      expect(__testing.isOpenAiReasoningModel(id)).toBe(true);
    }
  });

  it("rejects non-reasoning and compatible-endpoint model ids", () => {
    for (const id of [
      "gpt-4o",
      "gpt-4.1",
      "llama-3.1-70b-instruct",
      "mixtral-8x7b",
      "deepseek-chat",
      "openrouter/auto",
    ]) {
      expect(__testing.isOpenAiReasoningModel(id)).toBe(false);
    }
  });
});
