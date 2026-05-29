import type Steel from "steel-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "./pdf-extract.js";
import type {
  ModelAdapter,
  ModelAssistantBlock,
  ModelStepInput,
  ModelToolCall,
} from "./model.js";
import {
  __testing,
  createSourceReservations,
  createResearchCaches,
  createSteelConcurrencyGate,
  runResearchLoop,
  type ResearchLoopContext,
} from "./tools.js";
import type { SourceDocument } from "./sources.js";

vi.mock("./pdf-extract.js", () => ({
  extractPdfText: vi.fn(),
}));

function messageWith(content: ModelAssistantBlock[]): { content: ModelAssistantBlock[] } {
  return { content };
}

function finalReport(): { content: ModelAssistantBlock[] } {
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
): ModelToolCall {
  return { type: "tool_call", id, name, input };
}

function sourceDocument(
  url: string,
  title: string,
  markdown: string,
): SourceDocument {
  return {
    sourceId: "source_test",
    url,
    canonicalUrl: url,
    title,
    markdown,
    originalChars: markdown.length,
    storedChars: markdown.length,
    truncated: false,
    metadata: {
      markdownChars: markdown.length,
      extractionNotes: ["Test source."],
    },
    chunks: [{ index: 0, start: 0, end: markdown.length }],
  };
}

function createContext(opts: {
  messagesCreate: ReturnType<typeof vi.fn>;
  scrape?: unknown;
  fetchedSources?: ResearchLoopContext["fetchedSources"];
  sourceDocuments?: ResearchLoopContext["sourceDocuments"];
  sourceCap?: number;
  useProxy?: boolean;
  deadlineAt?: number;
  synthesisReserveMs?: number;
}): ResearchLoopContext {
  const scrape = (opts.scrape ?? vi.fn()) as ReturnType<typeof vi.fn>;
  let currentUrl = "about:blank";
  let currentTitle = "";
  let currentHtml = "<html><head><title></title></head><body></body></html>";
  const browserSessionPool = {
    acquire: vi.fn(async () => ({
      resource: {
        session: { id: "session_test" },
        cdpSessionId: "cdp_session_test",
        lastUsedAt: Date.now(),
        client: {
          waitForEvent: vi.fn(async () => undefined),
          send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
            if (method === "Page.navigate") {
              currentUrl = String(params?.url ?? currentUrl);
              const rendered = await scrape(
                {
                  url: currentUrl,
                  format: ["markdown"],
                  useProxy: opts.useProxy ?? false,
                },
                { signal: undefined },
              );
              const content = (rendered as {
                content?: { markdown?: string; html?: string };
                metadata?: { title?: string };
              })?.content ?? {};
              currentTitle = String(
                (rendered as { metadata?: { title?: string } })?.metadata?.title ??
                  currentUrl,
              );
              currentHtml =
                content.html ??
                `<html><head><title>${escapeHtml(currentTitle)}</title></head><body><main>${markdownToHtml(content.markdown ?? "")}</main></body></html>`;
              return {};
            }
            if (method === "Runtime.evaluate") {
              const expression = String(params?.expression ?? "");
              if (expression.includes("innerText.length")) {
                return { result: { value: currentHtml.length } };
              }
              return {
                result: {
                  value: {
                    url: currentUrl,
                    title: currentTitle,
                    html: currentHtml,
                  },
                },
              };
            }
            return {};
          }),
        },
      },
      release: vi.fn(async () => undefined),
    })),
  };
  return {
    model: {
      provider: "anthropic",
      model: "test-model",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      step: opts.messagesCreate as (input: ModelStepInput) => Promise<{ content: ModelAssistantBlock[] }>,
    } satisfies ModelAdapter,
    steel: { sessions: {} } as unknown as Steel,
    fetchedSources: opts.fetchedSources ?? [],
    sourceDocuments: opts.sourceDocuments ?? new Map(),
    emit: vi.fn(),
    abort: vi.fn(),
    defaultEngine: "ddg",
    useProxy: opts.useProxy ?? false,
    sourceCap: opts.sourceCap ?? 4,
    maxConcurrentTools: 2,
    deadlineAt: opts.deadlineAt,
    synthesisReserveMs: opts.synthesisReserveMs,
    steelConcurrencyGate: createSteelConcurrencyGate(2),
    browserSessionPool: browserSessionPool as unknown as ResearchLoopContext["browserSessionPool"],
    sourceReservations: createSourceReservations(),
    caches: createResearchCaches(),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markdownToHtml(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("# ")) {
        return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
      }
      return `<p>${escapeHtml(trimmed)}</p>`;
    })
    .join("");
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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("test direct fetch disabled");
    }),
  );
});

afterEach(() => {
  vi.mocked(extractPdfText).mockReset();
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

describe("research loop cache integration", () => {
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const secondRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    expect(toolResultText(secondRequest)).toContain('"results"');
    expect(toolResultText(secondRequest)).toContain('"engine": "ddg"');
    expect(scrape).toHaveBeenCalledTimes(3);
    expect(ctx.caches.serp.size).toBe(3);
  });

  it("ignores model-supplied engine and returns rank provenance", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response(
          `
            <html>
              <body>
                <div class="result">
                  <a class="result__a" href="https://example.com/ddg-one">DDG One</a>
                  <a class="result__snippet">First DDG snippet.</a>
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);
    const payload = JSON.parse(toolText) as {
      engines: string[];
      searched_engines: string[];
      results: Array<{
        rank: number;
        url: string;
        title: string;
        snippet?: string;
        engine: string;
        engine_rank: number;
        engines: string[];
      }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(payload.engines).toEqual(["ddg"]);
    expect(payload.searched_engines).toEqual(["ddg", "bing", "google"]);
    expect(payload.results).toEqual([
      {
        rank: 1,
        title: "DDG One",
        url: "https://example.com/ddg-one",
        snippet: "First DDG snippet.",
        engine: "ddg",
        engine_rank: 1,
        engines: ["ddg"],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("duckduckgo.com");
    expect(ctx.caches.serp.size).toBe(3);
  });

  it("merges results across engines and boosts duplicate URLs", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response(
          `
            <html>
              <body>
                <div class="result">
                  <a class="result__a" href="https://example.com/ddg-only">DDG Only</a>
                  <a class="result__snippet">Unique DDG result.</a>
                </div>
                <div class="result">
                  <a class="result__a" href="https://example.com/shared?utm_source=ddg">Shared Result</a>
                  <a class="result__snippet">Shared from DDG.</a>
                </div>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (href.includes("bing.com")) {
        return new Response(
          `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://example.com/shared">Shared Result</a></h2>
                  <div class="b_caption"><p>Shared from Bing.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="https://example.com/bing-only">Bing Only</a></h2>
                  <div class="b_caption"><p>Unique Bing result.</p></div>
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
                  <a href="https://example.com/google-only"><h3>Google Only</h3></a>
                  <div class="VwiC3b">Unique Google result.</div>
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
        messageWith([toolUse("search_1", "search", { query: "merge query" })]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const payload = JSON.parse(toolResultText(followupRequest)) as {
      engines: string[];
      results: Array<{
        rank: number;
        title: string;
        url: string;
        snippet?: string;
        engine: string;
        engine_rank: number;
        engines: string[];
      }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(payload.engines).toEqual(["ddg", "bing", "google"]);
    expect(payload.results[0]).toEqual({
      rank: 1,
      title: "Shared Result",
      url: "https://example.com/shared",
      snippet: "Shared from Bing.",
      engine: "bing",
      engine_rank: 1,
      engines: ["ddg", "bing"],
    });
    expect(payload.results.map((searchResult) => searchResult.url)).toEqual([
      "https://example.com/shared",
      "https://example.com/ddg-only",
      "https://example.com/google-only",
      "https://example.com/bing-only",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("runs batched search queries in one tool call", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      const q = new URL(href).searchParams.get("q") ?? "";
      if (href.includes("duckduckgo.com")) {
        return new Response(
          `
            <html>
              <body>
                <div class="result">
                  <a class="result__a" href="https://example.com/shared-paper">Shared Paper</a>
                  <a class="result__snippet">Snippet for ${q}.</a>
                </div>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>No matching results.</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("search_1", "search", {
            queries: ["alpha query", "beta query"],
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const payload = JSON.parse(toolResultText(followupRequest)) as {
      queries: string[];
      results: Array<{ url: string; queries?: string[] }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.toolCalls).toBe(1);
    expect(payload.queries).toEqual(["alpha query", "beta query"]);
    expect(payload.results[0]).toMatchObject({
      url: "https://example.com/shared-paper",
      queries: ["alpha query", "beta query"],
    });
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "search_results",
      index: 1,
      count: 1,
    });
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "search_results",
      index: 2,
      count: 1,
    });
  });

  it("does not reserve search indexes for malformed search calls", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response(
          `
            <html>
              <body>
                <div class="result">
                  <a class="result__a" href="https://example.com/valid">Valid Result</a>
                  <a class="result__snippet">Recovered after malformed call.</a>
                </div>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>No matching results.</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("bad_search", "search", {}),
          toolUse("good_search", "search", { queries: ["valid query"] }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });

    expect(ctx.emit).toHaveBeenCalledWith({
      type: "searching",
      index: 1,
      query: "valid query",
    });
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "search_results",
      index: 1,
      count: 1,
    });
  });

  it("normalizes stringified query arrays from model input", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response(
          `
            <html>
              <body>
                <div class="result">
                  <a class="result__a" href="https://example.com/normalized">Normalized Result</a>
                  <a class="result__snippet">Stringified query array worked.</a>
                </div>
              </body>
            </html>
          `,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>No matching results.</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("search_1", "search", {
            queries: '["alpha query","beta query"]',
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const payload = JSON.parse(toolResultText(followupRequest)) as {
      queries: string[];
      results: Array<{ queries?: string[] }>;
    };

    expect(payload.queries).toEqual(["alpha query", "beta query"]);
    expect(payload.results[0]?.queries).toEqual(["alpha query", "beta query"]);
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "searching",
      index: 1,
      query: "alpha query",
    });
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "searching",
      index: 2,
      query: "beta query",
    });
  });

  it("rejects malformed string query arrays without consuming search indexes", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("bad_search", "search", {
            queries: '["alpha" OR "beta", "gamma"]',
          }),
          toolUse("good_search", "search", { queries: ["valid query"] }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);

    expect(toolText).toContain(
      "Error: search requires `queries` to be an array of non-empty strings.",
    );
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "searching",
      index: 1,
      query: "valid query",
    });
  });

  it("merges another engine when the default engine fails", async () => {
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const payload = JSON.parse(toolResultText(followupRequest)) as {
      engines: string[];
      warnings: string[];
      results: Array<{
        rank: number;
        title: string;
        url: string;
        snippet?: string;
        engine: string;
        engine_rank: number;
        engines: string[];
      }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(payload.engines).toEqual(["bing"]);
    expect(payload.results).toEqual([
      {
        rank: 1,
        title: "Fallback Result",
        url: "https://example.com/fallback",
        snippet: "Fallback snippet.",
        engine: "bing",
        engine_rank: 1,
        engines: ["bing"],
      },
    ]);
    expect(payload.warnings[0]).toContain("ddg:");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(scrape).toHaveBeenCalledTimes(2);
    expect(ctx.caches.serp.size).toBe(3);
  });

  it("merges another engine when the default engine returns no results", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response("<html><body>No matching results.</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (href.includes("bing.com")) {
        return new Response(
          `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://example.com/empty-fallback">Empty Fallback</a></h2>
                  <div class="b_caption"><p>Found after empty default search.</p></div>
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
    const scrape = vi.fn(async () => ({
      content: { html: "<html><body>No browser results.</body></html>" },
      metadata: {},
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([toolUse("search_1", "search", { query: "empty query" })]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const payload = JSON.parse(toolResultText(followupRequest)) as {
      engines: string[];
      warnings: string[];
      results: Array<{
        rank: number;
        title: string;
        url: string;
        snippet?: string;
        engine: string;
        engine_rank: number;
        engines: string[];
      }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(payload.engines).toEqual(["bing"]);
    expect(payload.results).toEqual([
      {
        rank: 1,
        title: "Empty Fallback",
        url: "https://example.com/empty-fallback",
        snippet: "Found after empty default search.",
        engine: "bing",
        engine_rank: 1,
        engines: ["bing"],
      },
    ]);
    expect(payload.warnings[0]).toBe("ddg: no results");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(scrape).toHaveBeenCalledTimes(2);
  });

  it("advertises search, fetch, and evidence retrieval tools to the agent", async () => {
    const messagesCreate = vi.fn().mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const request = messagesCreate.mock.calls[0]?.[0] as {
      tools: Array<{
        name: string;
        input_schema: {
          properties?: Record<string, unknown>;
        };
      }>;
    };

    expect(request.tools.map((tool) => tool.name)).toEqual([
      "search",
      "fetch",
      "read_source_chunk",
      "find_in_source",
      "quote_source",
      "browser_open",
      "browser_cdp",
      "browser_extract",
      "plan",
    ]);
    expect(request.tools[0]?.input_schema.properties ?? {}).not.toHaveProperty("engine");
  });

  it("fetches browser-rendered page content into run memory keyed by URL", async () => {
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.fetchedSources).toEqual([
      {
        url: "https://example.com/source",
        title: "Primary Source",
        sourceId: "source_1",
        canonicalUrl: "https://example.com/source",
      },
    ]);
    expect(ctx.sourceDocuments.get("https://example.com/source")?.markdown).toContain("Detailed source body");
    expect(toolResultText(followupRequest)).toContain('"url": "https://example.com/source"');
    expect(toolResultText(followupRequest)).toContain('"source_id": "source_1"');
    expect(toolResultText(followupRequest)).toContain('"canonical_url": "https://example.com/source"');
    expect(toolResultText(followupRequest)).toContain('"chunk"');
    expect(toolResultText(followupRequest)).not.toContain('"extraction_method"');
    expect(toolResultText(followupRequest)).toContain('"content"');
  });

  it("continues reading a fetched source by URL and offset", async () => {
    const scrape = vi.fn(async () => ({
      content: {
        markdown: `# Primary Source\n\n${"Line-readable evidence about methods and controls. ".repeat(30)}`,
      },
      metadata: { title: "Primary Source" },
    }));
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
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const readRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(toolResultText(readRequest)).toContain('"url": "https://example.com/source"');
    expect(toolResultText(readRequest)).toContain('"offset": 80');
    expect(toolResultText(readRequest)).toContain("Line-readable evidence");
  });

  it("revisits fetched source evidence by source id, chunk, search, and quote span", async () => {
    const markdown =
      "# Evidence Source\n\nThis page compares methods and controls for the study.";
    const quoteStart = markdown.indexOf("methods and controls");
    const quoteEnd = quoteStart + "methods and controls".length;
    const scrape = vi.fn(async () => ({
      content: { markdown },
      metadata: { title: "Evidence Source" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/evidence",
            max_chars: 40,
          }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("read_1", "read_source_chunk", {
            source_id: "source_1",
            chunk_index: 0,
          }),
          toolUse("find_1", "find_in_source", {
            source_id: "source_1",
            query: "methods and controls",
          }),
          toolUse("quote_1", "quote_source", {
            source_id: "source_1",
            start: quoteStart,
            end: quoteEnd,
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 5,
    });
    const finalRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const text = toolResultText(finalRequest);

    expect(result.finishReason).toBe("final report");
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(text).toContain('"source_id": "source_1"');
    expect(text).toContain('"chunk":');
    expect(text).toContain('"matches":');
    expect(text).toContain('"quote": "methods and controls"');
  });

  it("shares an in-flight scrape for duplicate parallel fetches", async () => {
    const scrape = vi.fn(
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                content: {
                  markdown: "# Shared Source\n\nEvidence from one browser fetch.",
                },
                metadata: { title: "Shared Source" },
              }),
            1,
          );
        }),
    );
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/shared" }),
          toolUse("fetch_2", "fetch", { url: "https://example.com/shared" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report after tool call budget exhausted");
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.fetchedSources).toEqual([
      {
        url: "https://example.com/shared",
        title: "Shared Source",
        sourceId: "source_1",
        canonicalUrl: "https://example.com/shared",
      },
    ]);
    expect(toolResultText(followupRequest)).not.toContain("Already being fetched");
    expect(toolResultText(followupRequest)).toContain("Evidence from one browser fetch");
  });

  it("switches to final synthesis instead of starting tools near the deadline", async () => {
    const scrape = vi.fn();
    const messagesCreate = vi.fn();
    const ctx = createContext({
      messagesCreate,
      scrape,
      deadlineAt: Date.now() + 60_000,
      synthesisReserveMs: 10_000,
    });
    messagesCreate
      .mockImplementationOnce(async () => {
        ctx.deadlineAt = Date.now() + 5_000;
        return messageWith([
          toolUse("search_1", "search", { query: "expensive follow-up" }),
        ]);
      })
      .mockResolvedValueOnce(finalReport());

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const synthesisRequest = messagesCreate.mock.calls[1]?.[0] as {
      tools?: unknown;
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe(
      "final report after timeout approaching (5s remaining)",
    );
    expect(result.markdown).toContain("# Test Report");
    expect(result.toolCalls).toBe(0);
    expect(scrape).not.toHaveBeenCalled();
    expect(synthesisRequest.tools).toBeUndefined();
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "timeout approaching",
    );
  });

  it("preserves synthesis reserve when a research model step times out", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutController.signal);
    const scrape = vi.fn();
    const messagesCreate = vi.fn();
    const ctx = createContext({
      messagesCreate,
      scrape,
      deadlineAt: Date.now() + 60_000,
      synthesisReserveMs: 10_000,
    });
    messagesCreate
      .mockImplementationOnce(async (input: ModelStepInput) => {
        expect(input.tools).toBeDefined();
        expect(input.signal).toBe(timeoutController.signal);
        ctx.deadlineAt = Date.now() + 10_000;
        timeoutController.abort();
        throw new DOMException("Research step timed out", "AbortError");
      })
      .mockResolvedValueOnce(finalReport());

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const synthesisRequest = messagesCreate.mock.calls[1]?.[0] as {
      tools?: unknown;
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe(
      "final report after timeout approaching (10s remaining)",
    );
    expect(result.markdown).toContain("# Test Report");
    expect(result.toolCalls).toBe(0);
    expect(scrape).not.toHaveBeenCalled();
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(synthesisRequest.tools).toBeUndefined();
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "timeout approaching",
    );
  });

  it("starts research runs with a minimal research-question prompt", async () => {
    const messagesCreate = vi.fn().mockResolvedValueOnce(finalReport());
    const ctx = createContext({
      messagesCreate,
      fetchedSources: [
        {
          url: "https://example.com/primary",
          title: "Primary Source",
        },
      ],
      sourceDocuments: new Map([
        [
          "https://example.com/primary",
          sourceDocument(
            "https://example.com/primary",
            "Primary Source",
            "# Primary Source\n\nUseful evidence.",
          ),
        ],
      ]),
    });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const request = messagesCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(request.messages[0]?.content).toBe("Research question: What is Atlas?");
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "research_started",
    });
  });

  it("accepts a final report even with only a few sources", async () => {
    const messagesCreate = vi.fn().mockResolvedValueOnce(finalReport());
    const ctx = createContext({
      messagesCreate,
      fetchedSources: [
        { url: "https://example.com/one", title: "One" },
        { url: "https://example.com/two", title: "Two" },
      ],
    });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("continues reading fetched sources after the source cap is reached", async () => {
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
      fetchedSources: [
        { url: "https://example.com/capped", title: "Capped Source" },
      ],
      sourceDocuments: new Map([
        [
          "https://example.com/capped",
          sourceDocument(
            "https://example.com/capped",
            "Capped Source",
            "# Capped Source\n\nEvidence remains readable after the open cap.",
          ),
        ],
      ]),
      sourceCap: 1,
    });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toBe(
      "A concise supported answer without a forced heading scaffold.",
    );
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("asks for final synthesis without tools when tool budget is exhausted", async () => {
    const scrape = vi.fn(async () => ({
      content: {
        markdown: "# Budget Source\n\nUseful evidence gathered before the tool budget was exhausted.",
      },
      metadata: { title: "Budget Source" },
    }));
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
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 1,
    });
    const synthesisRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
      tools?: unknown;
    };

    expect(result.finishReason).toBe(
      "final report after tool call budget exhausted",
    );
    expect(result.markdown).toContain("# Test Report");
    expect(result.toolCalls).toBe(1);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(synthesisRequest.tools).toBeUndefined();
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "Runtime limit reached: tool call budget exhausted",
    );
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "Tool not run: tool call budget exhausted.",
    );
  });

  it("falls back to Steel when direct HTML fetch fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("direct fetch unavailable");
    });
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Steel Fetch\n\nRendered browser content." },
      metadata: { title: "Steel Fetch" },
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.fetchedSources[0]).toMatchObject({
      url: "https://example.com/js-app",
      title: "Steel Fetch",
    });
    expect(toolResultText(followupRequest)).not.toContain('"extraction_method"');
    expect(toolResultText(followupRequest)).toContain('"method": "browser_cdp"');
    expect(toolResultText(followupRequest)).toContain("network_error: direct fetch failed");
  });

  it("extracts static HTML before using Steel", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          `
            <html>
              <head><title>Direct HTML Source</title></head>
              <body>
                <main>
                  <h1>Direct HTML Source</h1>
                  <p>${"Static evidence from the original HTML page. ".repeat(5)}</p>
                </main>
              </body>
            </html>
          `,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Steel should not be used" },
      metadata: { title: "Steel" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/static" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);

    expect(result.finishReason).toBe("final report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(ctx.fetchedSources[0]).toMatchObject({
      url: "https://example.com/static",
      title: "Direct HTML Source",
    });
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "source_fetched",
      url: "https://example.com/static",
      title: "Direct HTML Source",
      method: "html_direct",
      markdownChars: expect.any(Number),
      attempts: [
        {
          method: "html_direct",
          ok: true,
          note: expect.stringContaining("html_direct: extracted"),
        },
      ],
      qualityWarnings: expect.any(Array),
    });
    expect(toolText).toContain("Static evidence from the original HTML page.");
    expect(toolText).toContain('"method": "html_direct"');
  });

  it("treats search result pages as discovery pages with links and capped content", async () => {
    const longListingText = `${"Search result summary. ".repeat(180)}TAIL_MARKER`;
    const fetch = vi.fn(
      async () =>
        new Response(
          `
            <html>
              <head><title>Example - Search Results</title></head>
              <body>
                <main>
                  <h1>Search Results</h1>
                  <p>${longListingText}</p>
                  <a href="/article/123">Useful Article</a>
                  <a href="https://example.com/article/456">Second Article</a>
                </main>
              </body>
            </html>
          `,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn();
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/search?q=x" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);

    expect(scrape).not.toHaveBeenCalled();
    expect(ctx.sourceDocuments.get("https://example.com/search?q=x")?.markdown).toContain(
      "TAIL_MARKER",
    );
    expect(toolText).toContain('"search_listing_page');
    expect(toolText).toContain('"source_quality"');
    expect(toolText).toContain('"discovery"');
    expect(toolText).toContain('"source_kind": "discovery_page"');
    expect(toolText).toContain("https://example.com/article/123");
    expect(toolText).toContain("Useful Article");
    expect(toolText).not.toContain("TAIL_MARKER");
  });

  it("extracts PDF URLs before using Steel", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(Buffer.from("%PDF-1.7\nfake test pdf"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": "22",
          },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.mocked(extractPdfText).mockResolvedValue({
      text: "PDF evidence text naming Johan Human.",
    });
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Steel should not be used" },
      metadata: { title: "Steel" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/FULL_TEXT.PDF",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);

    expect(result.finishReason).toBe("final report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(extractPdfText).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(ctx.fetchedSources[0]).toMatchObject({
      url: "https://example.com/FULL_TEXT.PDF",
      title: "FULL_TEXT.PDF",
    });
    expect(toolText).toContain("PDF evidence text naming Johan Human.");
    expect(toolText).toContain('"method": "pdf_direct"');
  });

  it("falls back to Steel when direct PDF extraction fails", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(Buffer.from("%PDF-1.7\nfake test pdf"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.mocked(extractPdfText).mockRejectedValue(new Error("bad pdf"));
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Steel Fetch\n\nRendered fallback content." },
      metadata: { title: "Steel Fetch" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/report.pdf",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });

    expect(result.finishReason).toBe("final report");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(extractPdfText).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.sourceDocuments.get("https://example.com/report.pdf")?.markdown).toContain(
      "Rendered fallback content.",
    );
    expect(
      ctx.sourceDocuments
        .get("https://example.com/report.pdf")
        ?.metadata.attempts?.map((attempt) => attempt.note)
        .join("\n"),
    ).toContain("pdf_parse_error: PDF extraction failed: bad pdf");
  });

  it("reports classified fetch failures when all extraction attempts fail", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<html><body>Checking your browser before accessing this site</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "" },
      metadata: { title: "Blocked" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/blocked" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(ctx.fetchedSources).toEqual([]);
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "source_error",
      url: "https://example.com/blocked",
      error: expect.stringContaining("blocked_or_challenge: direct HTML looked blocked"),
    });
    expect(toolResultText(followupRequest)).toContain(
      "Fetch failed: no content fetched.",
    );
  });

  it("rejects tiny error pages instead of storing them as sources", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("Not found", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "404 Page not found" },
      metadata: { title: "404 Page not found" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/missing" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(ctx.fetchedSources).toEqual([]);
    expect(ctx.sourceDocuments.size).toBe(0);
    expect(ctx.emit).toHaveBeenCalledWith({
      type: "source_error",
      url: "https://example.com/missing",
      error: "thin_content: extracted only 18 chars",
    });
    expect(toolResultText(followupRequest)).toContain(
      "Fetch failed: no content fetched.",
    );
  });

  it("passes proxy preference to Steel fetches", async () => {
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Proxied Fetch\n\nRendered browser content." },
      metadata: { title: "Proxied Fetch" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/proxy" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape, useProxy: true });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });

    expect(result.finishReason).toBe("final report");
    expect(scrape).toHaveBeenCalledWith(
      {
        url: "https://example.com/proxy",
        format: ["markdown"],
        useProxy: true,
      },
      expect.any(Object),
    );
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

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });

    expect(result.finishReason).toBe("final report");
    expect(ctx.fetchedSources).toEqual([]);
  });
});

describe("plan tool", () => {
  it("treats a plan tool call as a continuation, not the final answer", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("plan_1", "plan", {
            thought:
              "Outline the distinctive clues, then search each in parallel.",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 5,
    });
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(1);
    expect(result.finishReason).toBe("final report");
    expect(JSON.stringify(followupRequest.messages)).toContain(
      "Outline the distinctive clues",
    );
    expect(toolResultText(followupRequest)).toContain("Plan recorded");
  });
});
