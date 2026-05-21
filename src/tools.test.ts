import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  createResearchCaches,
  createSourceReservations,
  createSteelGate,
  runGatherAgent,
  type AgentContext,
} from "./tools.js";

function messageWith(content: unknown[]): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as unknown as Anthropic.Message;
}

function toolUse(
  id: string,
  name: "search" | "fetch" | "done",
  input: Record<string, unknown> = {},
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ToolUseBlock;
}

describe("tool helpers", () => {
  it("normalizes fetch URLs for dedupe keys", () => {
    expect(
      __testing.normalizeFetchUrl(
        "https://example.com/a?utm_source=x&b=2&a=1#section",
      ),
    ).toBe("https://example.com/a?a=1&b=2");
  });

  it("orders search fallback from the configured default engine", () => {
    expect(__testing.searchEnginesInFallbackOrder("bing")).toEqual([
      "bing",
      "ddg",
      "google",
    ]);
  });
});

describe("gather loop cache integration", () => {
  it("reuses cached SERPs across repeated search tool calls", async () => {
    const ddgHtml = `
      <div class="result">
        <a class="result__a" href="https://example.com/result">Result</a>
        <a class="result__snippet">Snippet.</a>
      </div>
    `;
    const scrape = vi.fn(async () => ({
      content: { html: ddgHtml },
      metadata: {},
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([toolUse("search_1", "search", { query: "same query" })]),
      )
      .mockResolvedValueOnce(
        messageWith([toolUse("search_2", "search", { query: "same query" })]),
      )
      .mockResolvedValueOnce(messageWith([toolUse("done_1", "done")]));

    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape } as unknown as Steel,
      sources: [],
      sourceUrls: new Set(),
      sourceMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      globalSourceCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      sourceReservations: createSourceReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 3,
    });

    expect(result.finish_reason).toBe("done");
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.caches.serp.size).toBe(1);
  });
});
