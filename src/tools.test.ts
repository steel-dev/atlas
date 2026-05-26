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
  name: string,
  input: Record<string, unknown> = {},
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ToolUseBlock;
}

function createContext(opts: {
  messagesCreate: Anthropic["messages"]["create"];
  scrape?: unknown;
  openedPages?: AgentContext["openedPages"];
  openedPageUrls?: AgentContext["openedPageUrls"];
  openedPageMarkdowns?: AgentContext["openedPageMarkdowns"];
  openedPageCap?: number;
}): AgentContext {
  return {
    anthropic: {
      messages: { create: opts.messagesCreate },
    } as unknown as Anthropic,
    steel: { scrape: opts.scrape ?? vi.fn() } as unknown as Steel,
    openedPages: opts.openedPages ?? [],
    openedPageUrls: opts.openedPageUrls ?? new Set(),
    openedPageMarkdowns: opts.openedPageMarkdowns ?? new Map(),
    emit: vi.fn(),
    abort: vi.fn(),
    defaultEngine: "ddg",
    useProxy: false,
    openedPageCap: opts.openedPageCap ?? 4,
    maxConcurrentTools: 2,
    steelGate: createSteelGate(2),
    openReservations: createOpenReservations(),
    caches: createResearchCaches(),
  };
}

function toolResultText(request: {
  messages: Array<{ content: unknown }>;
}): string {
  return request.messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block): block is { type: string; content?: unknown } =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type?: unknown }).type === "tool_result",
    )
    .map((block) => String(block.content ?? ""))
    .join("\n");
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
    const ctx = createContext({ messagesCreate, scrape });

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
    expect(toolResultText(secondRequest)).toContain('"results"');
    expect(toolResultText(secondRequest)).toContain('"engine": "ddg"');
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.caches.serp.size).toBe(1);
  });

  it("searches only the selected engine and returns rank provenance", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response("<html><body>Unexpected DuckDuckGo search</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (href.includes("bing.com")) {
        return new Response(
          `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://example.com/bing-one">Bing One</a></h2>
                  <div class="b_caption"><p>First Bing snippet.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="https://example.com/bing-two">Bing Two</a></h2>
                  <div class="b_caption"><p>Second Bing snippet.</p></div>
                </li>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (href.includes("google.com")) {
        return new Response(
          `
            <html>
              <body>
                <div class="g">
                  <a href="/url?q=${encodeURIComponent("https://example.com/shared")}&sa=U"><h3>Shared Result</h3></a>
                  <div class="VwiC3b">Shared from Google.</div>
                </div>
                <div class="g">
                  <a href="/url?q=${encodeURIComponent("https://example.com/google-only")}&sa=U"><h3>Google Only</h3></a>
                  <div class="VwiC3b">Google snippet.</div>
                </div>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>Unexpected engine</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("search_1", "search", {
            query: "selected query",
            engine: "bing",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);
    const payload = JSON.parse(toolText) as {
      requested_engine: string;
      engine: string;
      results: Array<{
        rank: number;
        url: string;
        title: string;
        snippet?: string;
        engine: string;
      }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(payload.requested_engine).toBe("bing");
    expect(payload.engine).toBe("bing");
    expect(payload.results).toEqual([
      {
        rank: 1,
        title: "Bing One",
        url: "https://example.com/bing-one",
        snippet: "First Bing snippet.",
        engine: "bing",
      },
      {
        rank: 2,
        title: "Bing Two",
        url: "https://example.com/bing-two",
        snippet: "Second Bing snippet.",
        engine: "bing",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("bing.com");
    expect(ctx.caches.serp.size).toBe(1);
  });

  it("falls back to another engine only after the requested engine fails", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response("enable javascript and cookies", {
          headers: { "content-type": "text/html" },
        });
      }
      if (href.includes("bing.com")) {
        return new Response(
          `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://example.com/fallback">Fallback Result</a></h2>
                  <div class="b_caption"><p>Fallback snippet.</p></div>
                </li>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>Unexpected engine</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => {
      throw new Error("blocked");
    });
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([toolUse("search_1", "search", { query: "fallback query" })]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const payload = JSON.parse(toolResultText(followupRequest)) as {
      requested_engine: string;
      engine: string;
      warnings: string[];
      results: Array<{
        rank: number;
        title: string;
        url: string;
        snippet?: string;
        engine: string;
      }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(payload.requested_engine).toBe("ddg");
    expect(payload.engine).toBe("bing");
    expect(payload.results).toEqual([
      {
        rank: 1,
        title: "Fallback Result",
        url: "https://example.com/fallback",
        snippet: "Fallback snippet.",
        engine: "bing",
      },
    ]);
    expect(payload.warnings[0]).toContain("ddg:");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.caches.serp.size).toBe(2);
  });

  it("advertises only search and fetch to the agent", async () => {
    const messagesCreate = vi.fn().mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });
    const request = messagesCreate.mock.calls[0]?.[0] as {
      tools: Array<{ name: string }>;
    };

    expect(request.tools.map((tool) => tool.name)).toEqual(["search", "fetch"]);
  });

  it("fetches page content into run memory keyed by URL", async () => {
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
          toolUse("fetch_1", "fetch", { url: "https://example.com/source" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

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
    expect(toolResultText(followupRequest)).toContain('"url": "https://example.com/source"');
    expect(toolResultText(followupRequest)).not.toContain('"extraction_method"');
    expect(toolResultText(followupRequest)).toContain('"content"');
  });

  it("continues reading a fetched source by URL and offset", async () => {
    const fetch = vi.fn(async () => {
      const body = `
        <html>
          <head><title>Primary Source</title></head>
          <body>
            <main>
              <h1>Primary Source</h1>
              ${"<p>Line-readable evidence about methods and controls.</p>".repeat(30)}
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
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/source",
            max_chars: 80,
          }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_2", "fetch", {
            url: "https://example.com/source",
            offset: 80,
            max_chars: 400,
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 3,
    });
    const readRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finish_reason).toBe("final report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(toolResultText(readRequest)).toContain('"url": "https://example.com/source"');
    expect(toolResultText(readRequest)).toContain('"offset": 80');
    expect(toolResultText(readRequest)).toContain("Line-readable evidence");
  });

  it("starts gather runs with a minimal research-question prompt", async () => {
    const messagesCreate = vi.fn().mockResolvedValueOnce(finalReport());
    const ctx = createContext({
      messagesCreate,
      openedPages: [
        {
          url: "https://example.com/primary",
          title: "Primary Source",
        },
      ],
      openedPageUrls: new Set(["https://example.com/primary"]),
      openedPageMarkdowns: new Map([
        ["https://example.com/primary", "# Primary Source\n\nUseful evidence."],
      ]),
    });

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
    const messagesCreate = vi.fn().mockResolvedValueOnce(finalReport());
    const ctx = createContext({
      messagesCreate,
      openedPages: [
        { url: "https://example.com/one", title: "One" },
        { url: "https://example.com/two", title: "Two" },
      ],
      openedPageUrls: new Set(["https://example.com/one", "https://example.com/two"]),
    });

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("continues reading fetched sources after the open page cap is reached", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/capped",
            offset: 0,
            max_chars: 200,
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({
      messagesCreate,
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
      openedPageCap: 1,
    });

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
    const ctx = createContext({ messagesCreate });

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
          toolUse("fetch_1", "fetch", { url: "https://example.com/budget" }),
          toolUse("fetch_2", "fetch", {
            url: "https://example.com/skipped-budget",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

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
          toolUse("fetch_1", "fetch", { url: "https://example.com/js-app" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

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
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "steel_fallback",
      url: "https://example.com/js-app",
      reason: "Plain fetch returned too little readable text (0 chars)",
    });
    expect(toolResultText(followupRequest)).not.toContain('"extraction_method"');
  });

  it("rejects removed virtual file tools", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("open_legacy", "open_url", {
            url: "https://example.com/legacy",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runGatherAgent({
      ctx,
      query: "What is Atlas?",
      max_tool_calls: 2,
    });

    expect(result.finish_reason).toBe("final report");
    expect(ctx.openedPages).toEqual([]);
  });
});
