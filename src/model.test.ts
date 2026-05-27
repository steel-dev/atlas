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
