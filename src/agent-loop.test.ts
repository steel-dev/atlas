import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop.js";
import type {
  ModelAdapter,
  ModelAssistantBlock,
  ModelStepInput,
  ModelToolCall,
  ModelToolResult,
} from "./model.js";

function toolCall(id: string): ModelToolCall {
  return { type: "tool_call", id, name: "read_source", input: { source_id: id } };
}

const text = (t: string): ModelAssistantBlock[] => [{ type: "text", text: t }];

/** Replays `script` content per step, repeating the last entry once exhausted. */
function scriptedAdapter(
  script: ModelAssistantBlock[][],
  opts: { inputTokensPerStep?: number } = {},
): ModelAdapter & { steps: ModelStepInput[] } {
  const steps: ModelStepInput[] = [];
  let i = 0;
  return {
    provider: "anthropic",
    model: "fake",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    steps,
    async step(input) {
      steps.push(input);
      const content = script[Math.min(i, script.length - 1)] ?? text("");
      i++;
      return opts.inputTokensPerStep !== undefined
        ? { content, inputTokens: opts.inputTokensPerStep }
        : { content };
    },
  } as ModelAdapter & { steps: ModelStepInput[] };
}

const echoTools = async (calls: ModelToolCall[]): Promise<ModelToolResult[]> =>
  calls.map((call) => ({
    type: "tool_result",
    tool_call_id: call.id,
    content: "ok",
  }));

describe("runAgentLoop", () => {
  it("stops when the model stops calling tools and threads the transcript", async () => {
    const adapter = scriptedAdapter([[toolCall("a")], text("done")]);
    let executed = 0;

    const result = await runAgentLoop({
      model: adapter,
      system: "s",
      tools: [],
      messages: [{ role: "user", content: "go" }],
      maxTokens: 100,
      maxTurns: 8,
      executeTools: async (calls) => {
        executed += calls.length;
        return echoTools(calls);
      },
    });

    expect(result.stopReason).toBe("no_tool_calls");
    expect(result.turns).toBe(1);
    expect(executed).toBe(1);
    expect(adapter.steps).toHaveLength(2);
    expect(result.lastContent).toEqual(text("done"));
    // initial user, assistant(tool call), user(tool result), assistant(text)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [toolCall("a")],
    });
    expect(result.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_call_id: "a", content: "ok" }],
    });
  });

  it("halts at the turn backstop when the model never stops", async () => {
    const adapter = scriptedAdapter([[toolCall("x")]]);

    const result = await runAgentLoop({
      model: adapter,
      system: "s",
      tools: [],
      messages: [{ role: "user", content: "go" }],
      maxTokens: 100,
      maxTurns: 3,
      executeTools: echoTools,
    });

    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(3);
    expect(adapter.steps).toHaveLength(3);
  });

  it("stops early when the governor trips", async () => {
    const adapter = scriptedAdapter([[toolCall("x")]]);

    const result = await runAgentLoop({
      model: adapter,
      system: "s",
      tools: [],
      messages: [{ role: "user", content: "go" }],
      maxTokens: 100,
      maxTurns: 8,
      executeTools: echoTools,
      shouldStop: ({ turn }) => (turn >= 2 ? "stop" : null),
    });

    expect(result.stopReason).toBe("governor");
    expect(result.turns).toBe(2);
    expect(adapter.steps).toHaveLength(2);
  });

  it("never steps when the governor is tripped from the start", async () => {
    const adapter = scriptedAdapter([[toolCall("x")]]);

    const result = await runAgentLoop({
      model: adapter,
      system: "s",
      tools: [],
      messages: [{ role: "user", content: "go" }],
      maxTokens: 100,
      maxTurns: 8,
      executeTools: echoTools,
      shouldStop: () => "already done",
    });

    expect(result.stopReason).toBe("governor");
    expect(result.turns).toBe(0);
    expect(adapter.steps).toHaveLength(0);
  });

  it("accumulates input tokens across steps", async () => {
    const adapter = scriptedAdapter([[toolCall("x")], text("done")], {
      inputTokensPerStep: 1_000,
    });

    const result = await runAgentLoop({
      model: adapter,
      system: "s",
      tools: [],
      messages: [{ role: "user", content: "go" }],
      maxTokens: 100,
      maxTurns: 8,
      executeTools: echoTools,
    });

    expect(result.inputTokens).toBe(2_000);
  });
});
