import { describe, expect, it } from "vitest";
import { __testing, type ModelMessage } from "./model.js";

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
            content: "{\"results\":[]}",
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
              arguments: "{\"query\":\"atlas research\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "{\"results\":[]}",
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
            arguments: "{\"url\":\"https://example.com\"}",
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
        { type: "thinking", thinking: "Outline the clues first.", signature: "sig-1" },
        { type: "tool_call", id: "call_1", name: "search", input: { queries: ["clue"] } },
      ],
    };

    expect(__testing.toAnthropicMessage(message)).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Outline the clues first.", signature: "sig-1" },
        { type: "tool_use", id: "call_1", name: "search", input: { queries: ["clue"] } },
      ],
    });
  });

  it("omits thinking blocks from OpenAI chat messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning", signature: "sig" },
          { type: "text", text: "visible answer" },
          { type: "tool_call", id: "call_1", name: "search", input: { queries: ["x"] } },
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
