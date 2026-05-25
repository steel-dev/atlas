import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  name: "search" | "inspect" | "fetch" | "done",
  input: Record<string, unknown> = {},
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ToolUseBlock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("parses Steel retry-after hints from rate limit errors", () => {
    expect(
      __testing.parseRetryAfterSeconds(
        Object.assign(new Error("Rate limit exceeded. Try again in 11 seconds."), {
          status: 429,
        }),
      ),
    ).toBe(11);
    expect(
      __testing.parseRetryAfterSeconds({
        status: 429,
        headers: { "retry-after": "7" },
      }),
    ).toBe(7);
    expect(__testing.parseRetryAfterSeconds(new Error("not rate limited"))).toBeNull();
  });
});

describe("gather loop cache integration", () => {
  it("reuses cached SERPs across repeated search tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("enable javascript and cookies", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );
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

  it("reuses inspected page content when committing the same URL", async () => {
    const fetch = vi.fn(async () => {
      const body = `
        <html>
          <head><title>Primary Source</title></head>
          <body>
            <main>
              <h1>Primary Source</h1>
              ${"<p>Detailed source body with enough useful research text for plain extraction.</p>".repeat(20)}
            </main>
          </body>
        </html>
      `;
      return new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Primary Source\n\nDetailed source body." },
      metadata: { title: "Primary Source" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("inspect_1", "inspect", { url: "https://example.com/source" }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/source" }),
        ]),
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
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(ctx.sources).toEqual([
      {
        n: 1,
        url: "https://example.com/source",
        title: "Primary Source",
      },
    ]);
    expect(ctx.sourceMarkdowns.get(1)).toContain("Detailed source body");
  });

  it("starts coverage passes with the existing source pool", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(messageWith([toolUse("done_1", "done")]));
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      sources: [
        {
          n: 1,
          url: "https://example.com/primary",
          title: "Primary Source",
        },
      ],
      sourceUrls: new Set(["https://example.com/primary"]),
      sourceMarkdowns: new Map([[1, "# Primary Source\n\nUseful evidence."]]),
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
      phase: "coverage",
    });
    const request = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };

    expect(result.phase).toBe("coverage");
    expect(result.finish_reason).toBe("done");
    expect(request.messages[0]?.content).toContain("Coverage pass");
    expect(request.messages[0]?.content).toContain(
      "[1] Primary Source — https://example.com/primary",
    );
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "agent_started",
      phase: "coverage",
    });
  });

  it("falls back to Steel when plain fetch has too little readable text", async () => {
    const fetch = vi.fn(async () =>
      new Response("<html><body><div id=\"root\"></div></body></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Steel Fallback\n\nRendered browser content." },
      metadata: { title: "Steel Fallback" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/js-app" }),
        ]),
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
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("done");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.sources[0]).toMatchObject({
      n: 1,
      url: "https://example.com/js-app",
      title: "Steel Fallback",
    });
  });

  it("aggregates search results across engines when configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("enable javascript and cookies", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const scrape = vi.fn(async ({ url }: { url: string }) => {
      if (url.includes("bing.com")) {
        return {
          content: {
            html: `
              <li class="b_algo">
                <h2><a href="https://example.com/bing">Bing Result</a></h2>
                <div class="b_caption"><p>Bing snippet.</p></div>
              </li>
            `,
          },
          metadata: {},
        };
      }
      if (url.includes("google.com")) {
        return {
          content: {
            html: `
              <div class="g">
                <a href="/url?q=${encodeURIComponent("https://example.com/google")}"><h3>Google Result</h3></a>
                <div class="VwiC3b">Google snippet.</div>
              </div>
            `,
          },
          metadata: {},
        };
      }
      return {
        content: {
          html: `
            <div class="result">
              <a class="result__a" href="https://example.com/ddg">DDG Result</a>
              <a class="result__snippet">DDG snippet.</a>
            </div>
          `,
        },
        metadata: {},
      };
    });
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([toolUse("search_1", "search", { query: "same query" })]),
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
      searchMode: "aggregate",
      defaultSearchLimit: 10,
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
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("done");
    expect(scrape).toHaveBeenCalledTimes(3);
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "search_results",
      index: 1,
      count: 3,
    });
  });
});
