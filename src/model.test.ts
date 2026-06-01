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

describe("model adapter message mapping", () => {
  it("maps Atlas tool-call transcripts to OpenAI chat messages", () => {
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

    const out = __testing.toOpenAIMessages("system prompt", messages);

    expect(out).toMatchObject([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Research question: what changed?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "search",
              arguments: '{"query":"atlas research"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"results":[]}',
      },
    ]);
  });

  it("maps OpenAI function calls back to Atlas tool calls", () => {
    const blocks = __testing.fromOpenAIMessage({
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "fetch",
            arguments: '{"url":"https://example.com"}',
          },
        },
      ],
    });

    expect(blocks).toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "fetch",
        input: { url: "https://example.com" },
      },
    ]);
  });
});

describe("anthropic extended-thinking preservation", () => {
  it("keeps thinking and redacted_thinking blocks when reading a response", () => {
    expect(
      __testing.fromAnthropicBlock({
        type: "thinking",
        thinking: "Weigh the candidates before committing.",
        signature: "sig-abc",
      }),
    ).toEqual([
      {
        type: "thinking",
        thinking: "Weigh the candidates before committing.",
        signature: "sig-abc",
      },
    ]);

    expect(
      __testing.fromAnthropicBlock({
        type: "redacted_thinking",
        data: "redacted-xyz",
      }),
    ).toEqual([{ type: "redacted_thinking", data: "redacted-xyz" }]);
  });

  it("passes thinking blocks back to Anthropic so reasoning carries across turns", () => {
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

    expect(__testing.toAnthropicMessage(message)).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Outline the clues first.",
          signature: "sig-1",
        },
        {
          type: "tool_use",
          id: "call_1",
          name: "search",
          input: { queries: ["clue"] },
        },
      ],
    });
  });

  it("omits thinking blocks from OpenAI chat messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            signature: "sig",
          },
          { type: "text", text: "visible answer" },
          {
            type: "tool_call",
            id: "call_1",
            name: "search",
            input: { queries: ["x"] },
          },
        ],
      },
    ];

    const out = __testing.toOpenAIMessages("system prompt", messages);
    const assistant = out.find((m) => m.role === "assistant") as {
      content: unknown;
      tool_calls?: unknown[];
    };

    expect(assistant.content).toBe("visible answer");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("internal reasoning");
  });
});
