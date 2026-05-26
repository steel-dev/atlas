import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createOpenReservations,
  createResearchCaches,
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

function finalReport(): Anthropic.Message {
  return messageWith([
    {
      type: "text",
      text:
        "# Test Report\n\nA concise supported finding from [Source](https://example.com/source).\n\n## Sources\n\nSource — https://example.com/source",
    },
  ]);
}

function toolUse(
  id: string,
  name: "search" | "open_url" | "list_sources" | "read_file" | "search_files",
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
      .mockResolvedValueOnce(finalReport());

    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 3,
    });
    const secondRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(secondRequest.messages)).toContain("Search metadata");
    expect(JSON.stringify(secondRequest.messages)).toContain("Engines tried");
    expect(scrape).toHaveBeenCalledTimes(3);
    expect(ctx.caches.serp.size).toBe(3);
  });

  it("opens page content into run memory", async () => {
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
          toolUse("open_1", "open_url", { url: "https://example.com/source" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());

    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(ctx.openedPages).toEqual([
      {
        url: "https://example.com/source",
        title: "Primary Source",
      },
    ]);
    expect(ctx.openedPageMarkdowns.get("https://example.com/source")).toContain("Detailed source body");
    expect(JSON.stringify(followupRequest.messages)).toContain("Extraction metadata");
    expect(JSON.stringify(followupRequest.messages)).toContain("Method: plain");
    expect(JSON.stringify(followupRequest.messages)).toContain("Stored markdown");
  });

  it("opens pages as virtual source files readable by line", async () => {
    const fetch = vi.fn(async () => {
      const body = `
        <html>
          <head><title>Primary Source</title></head>
          <body>
            <main>
              <h1>Primary Source</h1>
              <h2>Methods</h2>
              ${"<p>Line-readable evidence about methods and controls.</p>".repeat(20)}
            </main>
          </body>
        </html>
      `;
      return new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("open_1", "open_url", { url: "https://example.com/source" }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("read_1", "read_file", {
            path: "/sources/primary-source.md",
            start_line: 1,
            max_lines: 20,
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 3,
    });
    const readRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(JSON.stringify(readRequest.messages)).toContain(
      "Opened source file: /sources/primary-source.md",
    );
    expect(JSON.stringify(readRequest.messages)).toContain(
      "File: /sources/primary-source.md",
    );
    expect(JSON.stringify(readRequest.messages)).toContain("Line-readable evidence");
  });

  it("searches opened virtual source files", async () => {
    const fetch = vi.fn(async () => {
      const body = `
        <html>
          <head><title>Flavor Study</title></head>
          <body>
            <main>
              <h1>Flavor Study</h1>
              ${"<p>Methods text about sampling and controls.</p>".repeat(10)}
              ${"<p>Isoamyl acetate and ester compounds increased during ripening.</p>".repeat(10)}
            </main>
          </body>
        </html>
      `;
      return new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("open_1", "open_url", { url: "https://example.com/flavor" }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("search_files_1", "search_files", {
            query: "Isoamyl acetate",
            path: "/sources",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 3,
    });
    const searchRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(JSON.stringify(searchRequest.messages)).toContain(
      "matches for \\\"Isoamyl acetate\\\"",
    );
    expect(JSON.stringify(searchRequest.messages)).toContain(
      "/sources/flavor-study.md",
    );
  });

  it("starts gather runs with a minimal research-question prompt", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [
        {
          url: "https://example.com/primary",
          title: "Primary Source",
        },
      ],
      openedPageUrls: new Set(["https://example.com/primary"]),
      openedPageMarkdowns: new Map([["https://example.com/primary", "# Primary Source\n\nUseful evidence."]]),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 3,
    });
    const request = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(request.messages[0]?.content).toBe("Research question: What is Atlas?");
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "agent_started",
    });
  });

  it("accepts a final report even with only a few sources", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [
        { url: "https://example.com/one", title: "One" },
        { url: "https://example.com/two", title: "Two" },
      ],
      openedPageUrls: new Set(["https://example.com/one", "https://example.com/two"]),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("continues reading opened sources after the open page cap is reached", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("read_1", "read_file", {
            path: "/sources/capped-source.md",
            start_line: 1,
            max_lines: 20,
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [
        { url: "https://example.com/capped", title: "Capped Source" },
      ],
      openedPageUrls: new Set(["https://example.com/capped"]),
      openedPageMarkdowns: new Map([
        [
          "https://example.com/capped",
          "# Capped Source\n\nEvidence remains readable after the open cap.",
        ],
      ]),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 1,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(followupRequest.messages)).toContain(
      "Evidence remains readable after the open cap.",
    );
  });

  it("accepts non-empty final text without enforcing a report skeleton", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          {
            type: "text",
            text: "A concise supported answer without a forced heading scaffold.",
          },
        ]),
      );
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toBe(
      "A concise supported answer without a forced heading scaffold.",
    );
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("asks for final synthesis without tools when tool budget is exhausted", async () => {
    const fetch = vi.fn(async () => {
      const body = `
        <html>
          <head><title>Budget Source</title></head>
          <body>
            <main>
              <h1>Budget Source</h1>
              ${"<p>Useful evidence gathered before the tool budget was exhausted.</p>".repeat(20)}
            </main>
          </body>
        </html>
      `;
      return new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("open_1", "open_url", { url: "https://example.com/budget" }),
          toolUse("fetch_2", "open_url", {
            url: "https://example.com/skipped-budget",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 1,
    });
    const synthesisRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
      tools?: unknown;
    };

    expect(result.finish_reason).toBe(
      "final report after tool call budget exhausted",
    );
    expect(result.markdown).toContain("# Test Report");
    expect(result.tool_calls).toBe(1);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(synthesisRequest.tools).toBeUndefined();
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "Runtime limit reached: tool call budget exhausted",
    );
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "Tool not run: tool call budget exhausted.",
    );
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
          toolUse("open_1", "open_url", { url: "https://example.com/js-app" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());

    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.openedPages[0]).toMatchObject({
      url: "https://example.com/js-app",
      title: "Steel Fallback",
    });
    expect(JSON.stringify(followupRequest.messages)).toContain("Method: steel");
    expect(JSON.stringify(followupRequest.messages)).toContain(
      "Plain fetch fallback reason",
    );
  });

  it("ignores legacy fetch tool calls from older prompts", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          {
            type: "tool_use",
            id: "fetch_legacy",
            name: "fetch",
            input: { url: "https://example.com/legacy" },
          } as unknown as Anthropic.ToolUseBlock,
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx: AgentContext = {
      anthropic: {
        messages: { create: messagesCreate },
      } as unknown as Anthropic,
      steel: { scrape: vi.fn() } as unknown as Steel,
      openedPages: [],
      openedPageUrls: new Set(),
      openedPageMarkdowns: new Map(),
      emit: vi.fn(),
      abort: vi.fn(),
      defaultEngine: "ddg",
      useProxy: false,
      openedPageCap: 4,
      maxConcurrentTools: 2,
      steelGate: createSteelGate(2),
      openReservations: createOpenReservations(),
      caches: createResearchCaches(),
    };

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("final report");
    expect(ctx.openedPages).toEqual([]);
  });

});
