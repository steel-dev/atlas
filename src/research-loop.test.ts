import type Steel from "steel-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "./pdf-extract.js";
import type {
  ModelAdapter,
  ModelAssistantBlock,
  ModelStepInput,
  ModelStreamCallbacks,
  ModelToolCall,
} from "./model.js";
import { __testing, runResearchLoop } from "./research-loop.js";
import {
  createAgentScope,
  createSourceReservations,
  createResearchCaches,
  createConcurrencyGate,
  type ResearchCtx,
} from "./runtime.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./tool-contract.js";
import type { SourceDocument } from "./sources.js";

vi.mock("./pdf-extract.js", () => ({
  extractPdfText: vi.fn(),
}));

function messageWith(content: ModelAssistantBlock[]): {
  content: ModelAssistantBlock[];
} {
  return { content };
}

function finalReport(): { content: ModelAssistantBlock[] } {
  return messageWith([
    {
      type: "text",
      text: "# Test Report\n\nA concise supported finding from [Source](https://example.com/source).\n\n## Sources\n\nSource — https://example.com/source",
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
  fetchedSources?: ResearchCtx["store"]["fetchedSources"];
  sourceDocuments?: ResearchCtx["store"]["sourceDocuments"];
  sourceCap?: number;
  useProxy?: boolean;
  deadlineAt?: number;
  synthesisReserveMs?: number;
  depth?: number;
  summaryModel?: ModelAdapter;
  tokenLimit?: number;
  maxDelegationDepth?: number;
  maxConcurrentSubagents?: number;
  compactionTriggerTokens?: number;
  compactionKeepTokens?: number;
  subagentCompactionTriggerTokens?: number;
  subagentCompactionKeepTokens?: number;
}): ResearchCtx & { emitSpy: ReturnType<typeof vi.fn> } {
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
          send: vi.fn(
            async (method: string, params?: Record<string, unknown>) => {
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
                const content =
                  (
                    rendered as {
                      content?: { markdown?: string; html?: string };
                      metadata?: { title?: string };
                    }
                  )?.content ?? {};
                currentTitle = String(
                  (rendered as { metadata?: { title?: string } })?.metadata
                    ?.title ?? currentUrl,
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
            },
          ),
        },
      },
      release: vi.fn(async () => undefined),
    })),
  };
  const emit = vi.fn();
  return {
    config: {
      useProxy: opts.useProxy ?? false,
      sourceCap: opts.sourceCap ?? 4,
      maxConcurrentTools: 2,
      tokenLimit: opts.tokenLimit,
      maxDelegationDepth: opts.maxDelegationDepth,
      maxConcurrentSubagents: opts.maxConcurrentSubagents,
      subagentCompactionTriggerTokens: opts.subagentCompactionTriggerTokens,
      subagentCompactionKeepTokens: opts.subagentCompactionKeepTokens,
    },
    deps: {
      model: {
        provider: "anthropic",
        model: "test-model",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        step: opts.messagesCreate as (
          input: ModelStepInput,
        ) => Promise<{ content: ModelAssistantBlock[] }>,
      } satisfies ModelAdapter,
      summaryModel: opts.summaryModel,
      steel: { sessions: {}, scrape } as unknown as Steel,
      throwIfAborted: vi.fn(),
      ioGate: createConcurrencyGate(2),
      browserSessionPool:
        browserSessionPool as unknown as ResearchCtx["deps"]["browserSessionPool"],
    },
    store: {
      fetchedSources: opts.fetchedSources ?? [],
      sourceDocuments: opts.sourceDocuments ?? new Map(),
      sourceDocumentsById: new Map(
        Array.from((opts.sourceDocuments ?? new Map()).values()).map(
          (document) => [document.sourceId, document],
        ),
      ),
      sourceReservations: createSourceReservations(),
      caches: createResearchCaches(),
    },
    scope: createAgentScope({
      sink: emit,
      depth: opts.depth ?? 0,
      deadlineAt: opts.deadlineAt,
      synthesisReserveMs: opts.synthesisReserveMs,
      compactionTriggerTokens: opts.compactionTriggerTokens,
      compactionKeepTokens: opts.compactionKeepTokens,
    }),
    emitSpy: emit,
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
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter(
      (block): block is { type: string; content?: unknown } =>
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
      __testing.normalizeUrlForSource(
        "https://example.com/a?utm_source=x&b=2&a=1#section",
      ),
    ).toBe("https://example.com/a?a=1&b=2");
  });

  it("orders fusion engines with the configured default engine first", () => {
    expect(__testing.searchEnginesForFusion("bing")).toEqual([
      "bing",
      "ddg",
      "google",
    ]);
  });

  it("parses Steel retry-after hints from rate limit errors", () => {
    expect(
      __testing.parseRetryAfterSeconds(
        Object.assign(
          new Error("Rate limit exceeded. Try again in 11 seconds."),
          {
            status: 429,
          },
        ),
      ),
    ).toBe(11);
    expect(
      __testing.parseRetryAfterSeconds({
        status: 429,
        headers: { "retry-after": "7" },
      }),
    ).toBe(7);
    expect(
      __testing.parseRetryAfterSeconds(new Error("not rate limited")),
    ).toBeNull();
  });
});

describe("report streaming", () => {
  it("streams the lead report as a boundary then deltas and aggregates the same markdown", async () => {
    const reportText =
      "# Streamed Report\n\nFinding from [S](https://example.com/s).";
    const messagesCreate = vi.fn();
    const ctx = createContext({ messagesCreate });
    ctx.deps.model.stepStream = async (
      _input: ModelStepInput,
      callbacks: ModelStreamCallbacks,
    ): Promise<{ content: ModelAssistantBlock[] }> => {
      callbacks.onStart?.();
      callbacks.onText("# Streamed Report\n\n");
      callbacks.onText("Finding from [S](https://example.com/s).");
      return { content: [{ type: "text", text: reportText }] };
    };

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 2,
    });

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toBe(reportText);

    const emitted = ctx.emitSpy.mock.calls.map(
      (call) => call[0] as { type: string; text?: string },
    );
    const types = emitted.map((event) => event.type);
    const boundaryIndex = types.indexOf("report_boundary");
    const firstDeltaIndex = types.indexOf("report_delta");
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeLessThan(firstDeltaIndex);

    const deltas = emitted
      .filter((event) => event.type === "report_delta")
      .map((event) => event.text ?? "");
    expect(deltas.join("")).toBe(reportText);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("does not stream sub-agent reports", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValue(
        messageWith([{ type: "text", text: "# Sub Report\n\nDone." }]),
      );
    const ctx = createContext({ messagesCreate, depth: 1 });
    let streamed = false;
    ctx.deps.model.stepStream = async (
      _input: ModelStepInput,
      callbacks: ModelStreamCallbacks,
    ): Promise<{ content: ModelAssistantBlock[] }> => {
      streamed = true;
      callbacks.onText("x");
      return { content: [{ type: "text", text: "# Sub Report\n\nDone." }] };
    };

    const result = await runResearchLoop({
      ctx,
      query: "sub task",
      maxToolCalls: 2,
    });

    expect(result.markdown).toBe("# Sub Report\n\nDone.");
    expect(streamed).toBe(false);
    const types = ctx.emitSpy.mock.calls.map(
      (call) => (call[0] as { type: string }).type,
    );
    expect(types).not.toContain("report_delta");
    expect(types).not.toContain("report_boundary");
    expect(messagesCreate).toHaveBeenCalled();
  });
});

describe("research loop cache integration", () => {
  it("reuses cached SERPs across repeated search tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
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
    expect(ctx.store.caches.serp.size).toBe(3);
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
    expect(ctx.store.caches.serp.size).toBe(3);
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
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "search_results",
        index: 1,
        count: 1,
      }),
    );
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "search_results",
        index: 2,
        count: 1,
      }),
    );
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

    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "searching",
      index: 1,
      query: "valid query",
    });
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "search_results",
        index: 1,
        count: 1,
      }),
    );
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
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "searching",
      index: 1,
      query: "alpha query",
    });
    expect(ctx.emitSpy).toHaveBeenCalledWith({
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
    expect(ctx.emitSpy).toHaveBeenCalledWith({
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
        messageWith([
          toolUse("search_1", "search", { query: "fallback query" }),
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
    expect(ctx.store.caches.serp.size).toBe(1);
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
      "search_sources",
      "digest_source",
      "read_source",
      "run_code",
      "browser_open",
      "browser_cdp",
      "browser_extract",
      "plan",
    ]);
    expect(request.tools[0]?.input_schema.properties ?? {}).not.toHaveProperty(
      "engine",
    );
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
    expect(ctx.store.fetchedSources).toEqual([
      {
        url: "https://example.com/source",
        title: "Primary Source",
        sourceId: "source_1",
        canonicalUrl: "https://example.com/source",
      },
    ]);
    expect(
      ctx.store.sourceDocuments.get("https://example.com/source")?.markdown,
    ).toContain("Detailed source body");
    expect(toolResultText(followupRequest)).toContain(
      '"url": "https://example.com/source"',
    );
    expect(toolResultText(followupRequest)).toContain(
      '"source_id": "source_1"',
    );
    expect(toolResultText(followupRequest)).toContain(
      '"canonical_url": "https://example.com/source"',
    );
    expect(toolResultText(followupRequest)).toContain('"chunks"');
    expect(toolResultText(followupRequest)).not.toContain(
      '"extraction_method"',
    );
    expect(toolResultText(followupRequest)).toContain('"preview"');
    expect(toolResultText(followupRequest)).toContain('"raw_access"');
  });

  it("continues reading a fetched source by source id and chunk", async () => {
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
          toolUse("read_1", "read_source", {
            source_id: "source_1",
            chunk_index: 0,
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
    expect(toolResultText(readRequest)).toContain(
      '"url": "https://example.com/source"',
    );
    expect(toolResultText(readRequest)).toContain('"chunk"');
    expect(toolResultText(readRequest)).toContain('"content"');
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
          toolUse("read_1", "read_source", {
            source_id: "source_1",
            chunk_index: 0,
          }),
          toolUse("find_1", "search_sources", {
            source_ids: ["source_1"],
            query: "methods and controls",
          }),
          toolUse("quote_1", "read_source", {
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
    expect(result.toolCalls).toBe(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(text).toContain('"source_id": "source_1"');
    expect(text).toContain('"chunk":');
    expect(text).toContain('"matches":');
    expect(text).toContain('"quote": "methods and controls"');
    expect(JSON.stringify(finalRequest.messages)).not.toContain(
      "Budget status:",
    );
  });

  it("fetches many sources then searches the stored source set", async () => {
    const scrape = vi.fn(async (request: { url?: string }) => ({
      content: {
        markdown: request.url?.endsWith("/two")
          ? "# Second Source\n\nThe second clue is only in the second source."
          : "# First Source\n\nThe first source has background.",
      },
      metadata: {
        title: request.url?.endsWith("/two") ? "Second Source" : "First Source",
      },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            urls: ["https://example.com/one", "https://example.com/two"],
            preview_chars: 40,
          }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("search_sources_1", "search_sources", {
            query: "second clue",
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
    const fetchRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const searchRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.toolCalls).toBe(1);
    expect(scrape).toHaveBeenCalledTimes(2);
    expect(ctx.store.fetchedSources).toHaveLength(2);
    expect(toolResultText(fetchRequest)).toContain('"source_id": "source_1"');
    expect(toolResultText(fetchRequest)).toContain('"source_id": "source_2"');
    expect(toolResultText(searchRequest)).toContain("second clue");
    expect(toolResultText(searchRequest)).toContain('"source_id": "source_2"');
  });

  it("digests a stored source without using digest text as evidence", async () => {
    const scrape = vi.fn(async () => ({
      content: {
        markdown:
          "# Digest Source\n\nAlpha Beta appears in a paragraph that may guide later verification.",
      },
      metadata: { title: "Digest Source" },
    }));
    const digestCreate = vi.fn().mockResolvedValueOnce(
      messageWith([
        {
          type: "text",
          text: "Inspect the paragraph containing Alpha Beta, then verify it with raw source tools.",
        },
      ]),
    );
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", { url: "https://example.com/digest" }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("digest_1", "digest_source", {
            source_id: "source_1",
            goal: "Find promising verification points.",
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, scrape });
    ctx.deps.summaryModel = {
      provider: "anthropic",
      model: "digest-model",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      step: digestCreate as (
        input: ModelStepInput,
      ) => Promise<{ content: ModelAssistantBlock[] }>,
    } satisfies ModelAdapter;

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 3,
    });
    const digestRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(result.toolCalls).toBe(1);
    expect(digestCreate).toHaveBeenCalledTimes(1);
    expect(toolResultText(digestRequest)).toContain('"goal"');
    expect(toolResultText(digestRequest)).toContain("Alpha Beta");
    expect(toolResultText(digestRequest)).toContain(
      "Digest is only a navigation aid",
    );
  });

  it("shares an in-flight scrape for duplicate parallel fetches", async () => {
    const scrape = vi.fn(
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                content: {
                  markdown:
                    "# Shared Source\n\nEvidence from one browser fetch.",
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

    expect(result.finishReason).toBe(
      "final report after tool call budget exhausted",
    );
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.store.fetchedSources).toEqual([
      {
        url: "https://example.com/shared",
        title: "Shared Source",
        sourceId: "source_1",
        canonicalUrl: "https://example.com/shared",
      },
    ]);
    expect(toolResultText(followupRequest)).not.toContain(
      "Already being fetched",
    );
    expect(toolResultText(followupRequest)).toContain(
      "Evidence from one browser fetch",
    );
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
        ctx.scope.deadlineAt = Date.now() + 5_000;
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

  it("does not interrupt an in-flight research step for the synthesis reserve", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
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
        expect(input.signal).toBeUndefined();
        ctx.scope.deadlineAt = Date.now() + 5_000;
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
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).not.toHaveBeenCalled();
    timeoutSpy.mockRestore();
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
    expect(request.messages[0]?.content).toBe(
      "Research question: What is Atlas?",
    );
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "research_started",
    });
  });

  it("runs run_code over stored sources and returns grep provenance", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("code_1", "run_code", { code: 'grep("[0-9.]+ m³/t")' }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({
      messagesCreate,
      fetchedSources: [
        { url: "https://example.com/source", title: "Primary Source" },
      ],
      sourceDocuments: new Map([
        [
          "https://example.com/source",
          sourceDocument(
            "https://example.com/source",
            "Primary Source",
            "# Primary Source\n\nChile freshwater usage is 32.8 m³/t per ton.",
          ),
        ],
      ]),
    });

    const result = await runResearchLoop({ ctx, query: "q", maxToolCalls: 3 });
    const followup = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const text = toolResultText(followup);

    expect(result.finishReason).toBe("final report");
    expect(text).toContain("source_test");
    expect(text).toContain("32.8 m³/t");
    expect(text).toContain('"sources_in_scope": 1');
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
    const messagesCreate = vi.fn().mockResolvedValueOnce(
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
        markdown:
          "# Budget Source\n\nUseful evidence gathered before the tool budget was exhausted.",
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
      "Tool not run: action tool call budget exhausted.",
    );
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "Budget status:",
    );
    expect(JSON.stringify(synthesisRequest.messages)).toContain(
      "action_tool_calls=1/1",
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
    expect(ctx.store.fetchedSources[0]).toMatchObject({
      url: "https://example.com/js-app",
      title: "Steel Fetch",
    });
    expect(toolResultText(followupRequest)).not.toContain(
      '"extraction_method"',
    );
    expect(toolResultText(followupRequest)).toContain(
      '"method": "browser_cdp"',
    );
    expect(toolResultText(followupRequest)).toContain(
      "network_error: direct fetch failed",
    );
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
    expect(ctx.store.fetchedSources[0]).toMatchObject({
      url: "https://example.com/static",
      title: "Direct HTML Source",
    });
    expect(ctx.emitSpy).toHaveBeenCalledWith({
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

  it("extracts JSON responses directly before using Steel", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            esearchresult: {
              idlist: ["12345", "67890"],
              querytranslation:
                "MRC-5 bleomycin glutathione Free Radic Biol Med",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
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
          toolUse("fetch_1", "fetch", {
            url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json",
          }),
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

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(ctx.store.fetchedSources[0]).toMatchObject({
      url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json",
      title: "esearch.fcgi",
    });
    expect(toolText).toContain('"method": "json_direct"');
    expect(toolText).toContain("MRC-5 bleomycin glutathione");
  });

  it("extracts plain text responses directly before using Steel", async () => {
    const text = [
      "PMID- 12345",
      "TI  - A direct text abstract about MRC-5 bleomycin glutathione and fibrosis.",
      "AB  - This abstract is long enough to be stored without browser fallback. ".repeat(
        3,
      ),
    ].join("\n");
    const fetch = vi.fn(
      async () =>
        new Response(text, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
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
          toolUse("fetch_1", "fetch", {
            url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?retmode=text&rettype=abstract",
          }),
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

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(toolText).toContain('"method": "text_direct"');
    expect(toolText).toContain("PMID- 12345");
    expect(toolText).toContain("MRC-5 bleomycin glutathione");
  });

  it("treats search result pages as discovery pages without capping content", async () => {
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
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/search?q=x",
          }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          toolUse("search_sources_1", "search_sources", {
            query: "TAIL_MARKER",
          }),
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
    const searchRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    const toolText = toolResultText(followupRequest);
    const searchText = toolResultText(searchRequest);

    expect(scrape).not.toHaveBeenCalled();
    expect(
      ctx.store.sourceDocuments.get("https://example.com/search?q=x")?.markdown,
    ).toContain("TAIL_MARKER");
    expect(toolText).toContain('"search_listing_page');
    expect(toolText).toContain('"source_quality"');
    expect(toolText).toContain('"discovery"');
    expect(toolText).toContain('"source_kind": "discovery_page"');
    expect(toolText).toContain("https://example.com/article/123");
    expect(toolText).toContain("Useful Article");
    expect(searchText).toContain("TAIL_MARKER");
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
    expect(ctx.store.fetchedSources[0]).toMatchObject({
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
    expect(
      ctx.store.sourceDocuments.get("https://example.com/report.pdf")?.markdown,
    ).toContain("Rendered fallback content.");
    expect(
      ctx.store.sourceDocuments
        .get("https://example.com/report.pdf")
        ?.metadata.attempts?.map((attempt) => attempt.note)
        .join("\n"),
    ).toContain("pdf_parse_error: PDF extraction failed: bad pdf");
  });

  it("reports classified fetch failures when all extraction attempts fail", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          "<html><body>Checking your browser before accessing this site</body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
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
    expect(ctx.store.fetchedSources).toEqual([]);
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "source_error",
      url: "https://example.com/blocked",
      error: expect.stringContaining(
        "blocked_or_challenge: direct HTML looked blocked",
      ),
    });
    expect(toolResultText(followupRequest)).toContain(
      "Fetch failed: no content fetched.",
    );
  });

  it("returns suspicious but non-empty sources with quality warnings", async () => {
    const markdown =
      "# CAPTCHA in Practice\n\nThis article explains why a captcha or access denied message can appear in logs while still giving useful operational guidance.";
    const fetch = vi.fn(
      async () =>
        new Response(
          `<html><head><title>CAPTCHA in Practice</title></head><body><main>${markdown}</main></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown },
      metadata: { title: "CAPTCHA in Practice" },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/captcha-article",
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
    expect(ctx.store.fetchedSources).toHaveLength(1);
    expect(ctx.emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "source_error" }),
    );
    expect(toolText).toContain("This article explains why");
    expect(toolText).toContain("blocked_or_challenge");
    expect(toolText).toContain('"source_quality"');
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
    expect(ctx.store.fetchedSources).toEqual([]);
    expect(ctx.store.sourceDocuments.size).toBe(0);
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "source_error",
      url: "https://example.com/missing",
      error: "thin_content: extracted only 18 chars",
    });
    expect(toolResultText(followupRequest)).toContain(
      "Fetch failed: no content fetched.",
    );
  });

  it("routes direct fetches through proxied steel scrape when proxy is on", async () => {
    const body = "Rendered proxied evidence paragraph. ".repeat(10);
    const scrape = vi.fn(async () => ({
      content: {
        html: `<html><head><title>Proxied Fetch</title></head><body><main><h1>Proxied Fetch</h1><p>${body}</p></main></body></html>`,
      },
      metadata: { statusCode: 200, title: "Proxied Fetch" },
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
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledWith(
      {
        url: "https://example.com/proxy",
        format: ["html"],
        useProxy: true,
      },
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(
      ctx.store.sourceDocuments.get("https://example.com/proxy")?.metadata
        .method,
    ).toBe("scrape_proxy");
    expect(ctx.deps.browserSessionPool.acquire).not.toHaveBeenCalled();
  });

  it("keeps pdf urls on direct fetch even when proxy is on", async () => {
    const scrape = vi.fn(async () => ({
      content: { html: "<html><body>should not be used</body></html>" },
      metadata: { statusCode: 200 },
    }));
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("fetch_1", "fetch", {
            url: "https://example.com/whitepaper.pdf",
          }),
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
    expect(scrape).not.toHaveBeenCalledWith(
      expect.objectContaining({ format: ["html"] }),
      expect.anything(),
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
    expect(ctx.store.fetchedSources).toEqual([]);
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
    expect(result.toolCalls).toBe(0);
    expect(result.finishReason).toBe("final report");
    expect(JSON.stringify(followupRequest.messages)).toContain(
      "Outline the distinctive clues",
    );
    expect(toolResultText(followupRequest)).toContain("Plan recorded");
    expect(JSON.stringify(followupRequest.messages)).not.toContain(
      "Budget status:",
    );
  });
});

describe("context compaction", () => {
  function compactionModel(text: string) {
    const step = vi
      .fn()
      .mockResolvedValue(messageWith([{ type: "text", text }]));
    const adapter = {
      provider: "anthropic",
      model: "summary-model",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      step: step as (
        input: ModelStepInput,
      ) => Promise<{ content: ModelAssistantBlock[] }>,
    } satisfies ModelAdapter;
    return { adapter, step };
  }

  function twoBigPlanTurns() {
    return vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          { type: "text", text: `BIG1_MARKER ${"x".repeat(16_000)}` },
          toolUse("plan_1", "plan", { thought: "decompose the question" }),
        ]),
      )
      .mockResolvedValueOnce(
        messageWith([
          { type: "text", text: `BIG2_MARKER ${"y".repeat(16_000)}` },
          toolUse("plan_2", "plan", { thought: "keep going" }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
  }

  it("folds older turns into a progress note once the context exceeds the trigger", async () => {
    const messagesCreate = twoBigPlanTurns();
    const { adapter, step: compactionStep } = compactionModel(
      "COMPACTED_NOTE: the established facts so far.",
    );
    const ctx = createContext({ messagesCreate });
    ctx.deps.summaryModel = adapter;
    ctx.scope.compactionTriggerTokens = 200;
    ctx.scope.compactionKeepTokens = 50;

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 10,
    });
    const finalRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const serialized = JSON.stringify(finalRequest.messages);

    expect(result.finishReason).toBe("final report");
    expect(compactionStep).toHaveBeenCalledTimes(1);
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "context_compacted" }),
    );
    expect(finalRequest.messages[0]?.content).toBe(
      "Research question: What is Atlas?",
    );
    expect(finalRequest.messages[1]?.role).toBe("user");
    expect(String(finalRequest.messages[1]?.content)).toContain(
      "[Context compaction]",
    );
    expect(String(finalRequest.messages[1]?.content)).toContain(
      "COMPACTED_NOTE",
    );
    expect(finalRequest.messages[2]?.role).toBe("assistant");
    expect(serialized).not.toContain("BIG1_MARKER");
    expect(serialized).toContain("BIG2_MARKER");
  });

  it("leaves the transcript untouched when compaction is disabled", async () => {
    const messagesCreate = twoBigPlanTurns();
    const { adapter, step: compactionStep } = compactionModel("unused");
    const ctx = createContext({ messagesCreate });
    ctx.deps.summaryModel = adapter;

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 10,
    });
    const finalRequest = messagesCreate.mock.calls[2]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(result.finishReason).toBe("final report");
    expect(compactionStep).not.toHaveBeenCalled();
    expect(ctx.emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "context_compacted" }),
    );
    expect(JSON.stringify(finalRequest.messages)).toContain("BIG1_MARKER");
  });

  it("calibrates the compaction trigger to the model's reported prompt size", async () => {
    const TRIGGER = 20_000;

    function bigPlanTurns(inputTokens?: number) {
      const wrap = (content: ModelAssistantBlock[]) =>
        inputTokens === undefined ? { content } : { content, inputTokens };
      return vi
        .fn()
        .mockResolvedValueOnce(
          wrap([
            { type: "text", text: `BIG1_MARKER ${"x".repeat(16_000)}` },
            toolUse("plan_1", "plan", { thought: "decompose" }),
          ]),
        )
        .mockResolvedValueOnce(
          wrap([
            { type: "text", text: `BIG2_MARKER ${"y".repeat(16_000)}` },
            toolUse("plan_2", "plan", { thought: "keep going" }),
          ]),
        )
        .mockResolvedValueOnce(wrap(finalReport().content));
    }

    const baselineCreate = bigPlanTurns();
    const baseline = compactionModel("BASELINE_NOTE");
    const baselineCtx = createContext({ messagesCreate: baselineCreate });
    baselineCtx.deps.summaryModel = baseline.adapter;
    baselineCtx.scope.compactionTriggerTokens = TRIGGER;
    baselineCtx.scope.compactionKeepTokens = 50;

    const baselineResult = await runResearchLoop({
      ctx: baselineCtx,
      query: "What is Atlas?",
      maxToolCalls: 10,
    });
    const baselineFinal = JSON.stringify(
      (baselineCreate.mock.calls[2]?.[0] as { messages: unknown }).messages,
    );

    expect(baselineResult.finishReason).toBe("final report");
    expect(baseline.step).not.toHaveBeenCalled();
    expect(baselineCtx.emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "context_compacted" }),
    );
    expect(baselineFinal).toContain("BIG1_MARKER");

    const calibratedCreate = bigPlanTurns(5_000_000);
    const calibrated = compactionModel("CALIBRATED_NOTE");
    const calibratedCtx = createContext({ messagesCreate: calibratedCreate });
    calibratedCtx.deps.summaryModel = calibrated.adapter;
    calibratedCtx.scope.compactionTriggerTokens = TRIGGER;
    calibratedCtx.scope.compactionKeepTokens = 50;

    const calibratedResult = await runResearchLoop({
      ctx: calibratedCtx,
      query: "What is Atlas?",
      maxToolCalls: 10,
    });
    const calibratedFinal = JSON.stringify(
      (calibratedCreate.mock.calls[2]?.[0] as { messages: unknown }).messages,
    );

    expect(calibratedResult.finishReason).toBe("final report");
    expect(calibrated.step).toHaveBeenCalledTimes(1);
    expect(calibratedCtx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "context_compacted" }),
    );
    expect(calibratedFinal).not.toContain("BIG1_MARKER");
    expect(calibratedFinal).toContain("BIG2_MARKER");
    expect(calibratedFinal).toContain("CALIBRATED_NOTE");
  });
});

describe("token budget", () => {
  it("stops starting new steps once the token budget is exhausted and finalizes", async () => {
    let ctx: ResearchCtx;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (!input.tools) return finalReport();
      ctx.deps.model.usage.output_tokens += 5_000;
      return messageWith([
        toolUse(`plan_${ctx.deps.model.usage.output_tokens}`, "plan", {
          thought: "keep going",
        }),
      ]);
    });
    ctx = createContext({ messagesCreate, tokenLimit: 8_000 });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 50,
    });
    const synthesisRequest = messagesCreate.mock.calls.at(-1)?.[0] as {
      tools?: unknown;
      messages: Array<{ content: unknown }>;
    };

    expect(result.finishReason).toBe(
      "final report after token budget exhausted",
    );
    expect(result.markdown).toContain("# Test Report");
    expect(result.toolCalls).toBe(0);
    expect(messagesCreate).toHaveBeenCalledTimes(3);
    expect(synthesisRequest.tools).toBeUndefined();
    expect(JSON.stringify(synthesisRequest.messages)).toContain("tokens_used=");
  });

  it("does not enforce a token budget when tokenLimit is unset", async () => {
    let calls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      calls++;
      if (!input.tools || calls > 1) return finalReport();
      return messageWith([toolUse("plan_1", "plan", { thought: "one step" })]);
    });
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 50,
    });

    expect(result.finishReason).toBe("final report");
    expect(
      JSON.stringify(messagesCreate.mock.calls).includes("tokens_used="),
    ).toBe(false);
  });
});

describe("spawn/join fan-out", () => {
  it("refuses spawn when finalization reserve would be consumed", async () => {
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        return messageWith([
          {
            type: "text",
            text: "This sub-agent should not run.",
          },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["What is the local population?"],
          }),
        ]);
      }
      return finalReport();
    });

    const ctx = createContext({
      messagesCreate,
      deadlineAt: Date.now() + 20_000,
      synthesisReserveMs: 10_000,
      maxDelegationDepth: 1,
    });

    const result = await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });
    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadFinal = calls.at(-1) as ModelStepInput;

    expect(result.finishReason).toBe("final report");
    expect(calls.some((call) => call.system === SUBAGENT_SYSTEM_PROMPT)).toBe(
      false,
    );
    expect(toolResultText(leadFinal)).toContain(
      "not enough remaining time to spawn sub-agents",
    );
    expect(ctx.emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "delegation_started" }),
    );
  });

  it("spawns a sub-agent, joins it, and returns its findings to the lead", async () => {
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        return messageWith([
          {
            type: "text",
            text: "Sub-finding: the local population is 12,345, per https://example.com/census.",
          },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["What is the local population?"],
          }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });

    const ctx = createContext({
      messagesCreate,
      maxDelegationDepth: 1,
      maxConcurrentSubagents: 2,
    });

    const result = await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadFirst = calls[0];
    const subagentCall = calls.find(
      (call) => call.system === SUBAGENT_SYSTEM_PROMPT,
    );
    const leadFinal = calls
      .filter((call) => call.system !== SUBAGENT_SYSTEM_PROMPT)
      .at(-1) as ModelStepInput;

    expect(leadFirst.tools?.map((tool) => tool.name)).toContain("spawn");
    expect(leadFirst.tools?.map((tool) => tool.name)).toContain("join");
    expect(subagentCall).toBeDefined();
    expect(subagentCall?.tools?.map((tool) => tool.name) ?? []).not.toContain(
      "spawn",
    );
    expect(subagentCall?.tools?.map((tool) => tool.name) ?? []).not.toContain(
      "join",
    );

    expect(JSON.stringify(subagentCall?.messages)).toContain(
      "What is the local population?",
    );
    expect(JSON.stringify(subagentCall?.messages)).not.toContain(
      "Profile this town.",
    );

    expect(toolResultText(leadFinal)).toContain(
      "Sub-finding: the local population is 12,345",
    );
    expect(toolResultText(leadFinal)).toContain("joined");

    expect(result.finishReason).toBe("final report");
    expect(result.toolCalls).toBe(1);

    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "delegation_started",
      tasks: ["What is the local population?"],
    });
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "subagent_started",
      task: "What is the local population?",
    });
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "subagent_finished",
      task: "What is the local population?",
      sourcesFetched: 0,
      toolCalls: 0,
      finishReason: "final report",
    });
  });

  it("never runs more sub-agents at once than maxConcurrentSubagents", async () => {
    let active = 0;
    let peak = 0;
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return messageWith([{ type: "text", text: "Sub-finding done." }]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["task one", "task two", "task three", "task four"],
          }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });

    const ctx = createContext({
      messagesCreate,
      maxDelegationDepth: 1,
      maxConcurrentSubagents: 2,
    });

    const result = await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });

    const subagentCalls = messagesCreate.mock.calls.filter(
      ([input]) => (input as ModelStepInput).system === SUBAGENT_SYSTEM_PROMPT,
    );

    expect(result.finishReason).toBe("final report");
    expect(subagentCalls).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it("returns a sub-agent's browser session to the pool when it finishes", async () => {
    let leadCalls = 0;
    let subCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls += 1;
        if (subCalls === 1) {
          return messageWith([
            toolUse("sub_browser", "browser_open", {
              url: "https://example.com/live",
            }),
          ]);
        }
        return messageWith([
          {
            type: "text",
            text: "Live page reports the population is 12,345 per https://example.com/live.",
          },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["What does the live page report?"],
          }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });

    const ctx = createContext({
      messagesCreate,
      maxDelegationDepth: 1,
      maxConcurrentSubagents: 2,
    });

    const pool = ctx.deps.browserSessionPool as unknown as {
      acquire: () => Promise<{ release: ReturnType<typeof vi.fn> }>;
    };
    const realAcquire = pool.acquire;
    const leases: Array<{ release: ReturnType<typeof vi.fn> }> = [];
    pool.acquire = vi.fn(async () => {
      const lease = await realAcquire();
      leases.push(lease);
      return lease;
    });

    const result = await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });

    expect(result.finishReason).toBe("final report");
    expect(leases).toHaveLength(1);
    expect(leases[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("shares the source store and tags sub-agent fetch events with depth", async () => {
    const scrape = vi.fn(async () => ({
      content: {
        markdown:
          "# Census\n\nThe local population is 12,345 per the 2020 census.",
      },
      metadata: { title: "Census" },
    }));
    let leadCalls = 0;
    let subCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls += 1;
        if (subCalls === 1) {
          return messageWith([
            toolUse("sub_fetch", "fetch", {
              url: "https://example.com/census",
            }),
          ]);
        }
        return messageWith([
          {
            type: "text",
            text: "Population is 12,345 per https://example.com/census.",
          },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["What is the local population?"],
          }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });

    const ctx = createContext({
      messagesCreate,
      scrape,
      maxDelegationDepth: 1,
      maxConcurrentSubagents: 2,
    });

    const result = await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });
    const leadFinal = messagesCreate.mock.calls
      .filter(
        ([call]) => (call as ModelStepInput).system !== SUBAGENT_SYSTEM_PROMPT,
      )
      .at(-1)?.[0] as { messages: Array<{ content: unknown }> };

    expect(result.finishReason).toBe("final report");
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(ctx.emitSpy).toHaveBeenCalledWith({
      type: "fetching",
      url: "https://example.com/census",
      depth: 1,
    });
    expect(ctx.store.fetchedSources).toContainEqual({
      url: "https://example.com/census",
      title: "Census",
      sourceId: "source_1",
      canonicalUrl: "https://example.com/census",
    });
    expect(toolResultText(leadFinal)).toContain("source_1");
    expect(toolResultText(leadFinal)).toContain("Population is 12,345");
    expect(result.fetchedUrls).toContain("https://example.com/census");
  });

  it("hides spawn/join and refuses spawn when depth is exhausted", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          toolUse("spawn_blocked", "spawn", {
            tasks: ["Anything."],
          }),
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });
    ctx.scope.depth = 1;

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 20,
    });
    const firstCall = messagesCreate.mock.calls[0]?.[0] as ModelStepInput;
    const followupRequest = messagesCreate.mock.calls[1]?.[0] as {
      messages: Array<{ content: unknown }>;
    };

    expect(firstCall.tools?.map((tool) => tool.name) ?? []).not.toContain(
      "spawn",
    );
    expect(firstCall.tools?.map((tool) => tool.name) ?? []).not.toContain(
      "join",
    );
    expect(toolResultText(followupRequest)).toContain(
      "spawn is not available at this depth",
    );
    expect(result.finishReason).toBe("final report");
  });

  it("compacts a sub-agent's context at the sub-agent trigger while the lead's stays off", async () => {
    let subCalls = 0;
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls++;
        if (subCalls <= 2) {
          return messageWith([
            { type: "text", text: `SUB_BIG${subCalls} ${"z".repeat(16_000)}` },
            toolUse(`sub_plan_${subCalls}`, "plan", { thought: "investigate" }),
          ]);
        }
        return messageWith([
          {
            type: "text",
            text: "Findings: the answer is 42, per https://example.com/a.",
          },
        ]);
      }
      leadCalls++;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["What is the answer?"],
          }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const compactionStep = vi
      .fn()
      .mockResolvedValue(
        messageWith([{ type: "text", text: "SUB_NOTE: progress." }]),
      );
    const ctx = createContext({
      messagesCreate,
      maxDelegationDepth: 1,
      maxConcurrentSubagents: 1,
      subagentCompactionTriggerTokens: 200,
      subagentCompactionKeepTokens: 50,
    });
    ctx.deps.summaryModel = {
      provider: "anthropic",
      model: "summary-model",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      step: compactionStep as (
        input: ModelStepInput,
      ) => Promise<{ content: ModelAssistantBlock[] }>,
    } satisfies ModelAdapter;
    ctx.scope.compactionTriggerTokens = undefined;

    const result = await runResearchLoop({
      ctx,
      query: "Solve it.",
      maxToolCalls: 20,
    });

    expect(result.finishReason).toBe("final report");
    expect(compactionStep).toHaveBeenCalledTimes(1);
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "context_compacted", depth: 1 }),
    );
  });
});

describe("lead↔sub-agent messaging", () => {
  it("offers messaging tools to both sides and injects a lead redirect into the sub-agent", async () => {
    let subCalls = 0;
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls += 1;
        if (subCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return messageWith([
            toolUse("sub_plan_1", "plan", { thought: "scoping" }),
          ]);
        }
        return messageWith([
          { type: "text", text: "Findings: narrowed per the lead's note." },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["Investigate the founding year."],
          }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([
          toolUse("send_1", "send_message", {
            to: "agent_1",
            content: "Focus only on the 1887 charter.",
          }),
        ]);
      }
      if (leadCalls === 3) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    const result = await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadFirst = calls[0] as ModelStepInput;
    const subagentCalls = calls.filter(
      (call) => call.system === SUBAGENT_SYSTEM_PROMPT,
    );
    const leadNames = leadFirst.tools?.map((tool) => tool.name) ?? [];
    const subagentNames =
      subagentCalls[0]?.tools?.map((tool) => tool.name) ?? [];

    expect(leadNames).toContain("send_message");
    expect(leadNames).toContain("wait_for_message");
    expect(subagentNames).toContain("send_message");
    expect(subagentNames).toContain("wait_for_message");
    expect(subagentNames).not.toContain("spawn");
    expect(subagentNames).not.toContain("join");

    const subagentSecond = JSON.stringify(subagentCalls[1]?.messages ?? []);
    expect(subagentSecond).toContain(
      "Messages received while you were working:",
    );
    expect(subagentSecond).toContain(
      "[from lead] Focus only on the 1887 charter.",
    );
    expect(result.finishReason).toBe("final report");
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message_sent",
        from: "lead",
        to: "agent_1",
      }),
    );
  });

  it("delivers a sub-agent's interim message to the lead between tool calls", async () => {
    let subCalls = 0;
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls += 1;
        if (subCalls === 1) {
          return messageWith([
            toolUse("sub_send_1", "send_message", {
              to: "lead",
              content: "Interim: found the 1887 charter.",
            }),
          ]);
        }
        return messageWith([
          { type: "text", text: "Findings: charter confirmed." },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", { tasks: ["Find the charter."] }),
        ]);
      }
      if (leadCalls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return messageWith([
          toolUse("plan_1", "plan", { thought: "keep working" }),
        ]);
      }
      if (leadCalls === 3) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    await runResearchLoop({
      ctx,
      query: "Profile this town.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadThird = calls.filter(
      (call) => call.system !== SUBAGENT_SYSTEM_PROMPT,
    )[2] as ModelStepInput;
    const leadThirdJson = JSON.stringify(leadThird.messages);
    expect(leadThirdJson).toContain("Messages received while you were working:");
    expect(leadThirdJson).toContain(
      "[from agent_1] Interim: found the 1887 charter.",
    );
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message_sent",
        from: "agent_1",
        to: "lead",
        depth: 1,
      }),
    );
  });

  it("wakes a lead parked in wait_for_message when a sub-agent sends", async () => {
    let subCalls = 0;
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls += 1;
        if (subCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return messageWith([
            toolUse("sub_send_1", "send_message", {
              to: "lead",
              content: "Found it: 42.",
            }),
          ]);
        }
        return messageWith([{ type: "text", text: "Findings: it is 42." }]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", { tasks: ["Send me what you find."] }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([
          toolUse("wait_1", "wait_for_message", { timeout_ms: 600000 }),
        ]);
      }
      if (leadCalls === 3) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    const result = await runResearchLoop({
      ctx,
      query: "Answer via sub-agent.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadThird = calls.filter(
      (call) => call.system !== SUBAGENT_SYSTEM_PROMPT,
    )[2] as ModelStepInput;
    expect(toolResultText(leadThird)).toContain('"from": "agent_1"');
    expect(toolResultText(leadThird)).toContain("Found it: 42.");
    expect(result.finishReason).toBe("final report");
  });

  it("times out a parked wait while sub-agents are still working", async () => {
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return messageWith([{ type: "text", text: "Findings: slow work." }]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", { tasks: ["Take your time."] }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([
          toolUse("wait_1", "wait_for_message", { timeout_ms: 10 }),
        ]);
      }
      if (leadCalls === 3) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    await runResearchLoop({
      ctx,
      query: "Patience test.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadThird = calls.filter(
      (call) => call.system !== SUBAGENT_SYSTEM_PROMPT,
    )[2] as ModelStepInput;
    expect(toolResultText(leadThird)).toContain('"timed_out": true');
  });

  it("resolves a parked wait with no_more_senders when the last sub-agent finishes silently", async () => {
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        return messageWith([{ type: "text", text: "Findings: quick check." }]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", { tasks: ["Quick check."] }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([
          toolUse("wait_1", "wait_for_message", { timeout_ms: 600000 }),
        ]);
      }
      if (leadCalls === 3) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    const result = await runResearchLoop({
      ctx,
      query: "Quick delegation.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const leadThird = calls.filter(
      (call) => call.system !== SUBAGENT_SYSTEM_PROMPT,
    )[2] as ModelStepInput;
    expect(toolResultText(leadThird)).toContain('"no_more_senders": true');
    expect(result.finishReason).toBe("final report");
  });

  it("frees a sub-agent parked in wait_for_message when the lead joins", async () => {
    let subCalls = 0;
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        subCalls += 1;
        if (subCalls === 1) {
          return messageWith([
            toolUse("sub_wait_1", "wait_for_message", { timeout_ms: 600000 }),
          ]);
        }
        return messageWith([
          { type: "text", text: "Done after the collect note." },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", {
            tasks: ["Wait for instructions, then report."],
          }),
        ]);
      }
      if (leadCalls === 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    const result = await runResearchLoop({
      ctx,
      query: "Coordination test.",
      maxToolCalls: 20,
    });

    const calls = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    const subagentSecond = calls.filter(
      (call) => call.system === SUBAGENT_SYSTEM_PROMPT,
    )[1] as ModelStepInput;
    expect(toolResultText(subagentSecond)).toContain(
      "the lead is collecting findings now",
    );
    const leadFinal = calls
      .filter((call) => call.system !== SUBAGENT_SYSTEM_PROMPT)
      .at(-1) as ModelStepInput;
    expect(toolResultText(leadFinal)).toContain("Done after the collect note.");
    expect(result.finishReason).toBe("final report");
  });

  it("rejects messages to unknown recipients", async () => {
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (_input: ModelStepInput) => {
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("send_1", "send_message", { to: "agent_9", content: "hi" }),
        ]);
      }
      return finalReport();
    });
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    await runResearchLoop({
      ctx,
      query: "Misaddressed message.",
      maxToolCalls: 20,
    });

    const second = messagesCreate.mock.calls[1]?.[0] as ModelStepInput;
    expect(toolResultText(second)).toContain(
      "Error: unknown recipient 'agent_9'",
    );
    expect(toolResultText(second)).toContain("Known recipients: lead");
    expect(ctx.emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "message_sent" }),
    );
  });
});

describe("emergent team via spawn/join", () => {
  it("spawns breadth in one turn, joins all, and merges a report", async () => {
    let leadCalls = 0;
    const messagesCreate = vi.fn(async (input: ModelStepInput) => {
      if (input.system === SUBAGENT_SYSTEM_PROMPT) {
        return messageWith([
          {
            type: "text",
            text: "Finding from agent, per https://example.com/x.",
          },
        ]);
      }
      leadCalls += 1;
      if (leadCalls === 1) {
        return messageWith([
          toolUse("spawn_1", "spawn", { tasks: ["Sub A?", "Sub B?"] }),
        ]);
      }
      if (leadCalls === 2) {
        return messageWith([toolUse("join_1", "join", {})]);
      }
      return finalReport();
    });
    const ctx = createContext({
      messagesCreate,
      maxDelegationDepth: 1,
      maxConcurrentSubagents: 2,
    });

    const result = await runResearchLoop({
      ctx,
      query: "Big question?",
      maxToolCalls: 20,
      suggestedParallelism: 2,
    });
    const leadFinal = messagesCreate.mock.calls
      .map(([input]) => input as ModelStepInput)
      .filter((call) => call.system !== SUBAGENT_SYSTEM_PROMPT)
      .at(-1) as ModelStepInput;

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("# Test Report");
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delegation_started",
        tasks: ["Sub A?", "Sub B?"],
      }),
    );
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subagent_started", task: "Sub A?" }),
    );
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subagent_started", task: "Sub B?" }),
    );
    expect(toolResultText(leadFinal)).toContain("Finding from agent");
  });

  it("behaves as a single agent when the lead never spawns", async () => {
    const messagesCreate = vi.fn(async (_input: ModelStepInput) =>
      finalReport(),
    );
    const ctx = createContext({ messagesCreate, maxDelegationDepth: 1 });

    const result = await runResearchLoop({
      ctx,
      query: "Atomic question?",
      maxToolCalls: 5,
    });

    expect(result.finishReason).toBe("final report");
    expect(ctx.emitSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "delegation_started" }),
    );
    expect(
      messagesCreate.mock.calls.some(
        ([input]) =>
          (input as ModelStepInput).system === SUBAGENT_SYSTEM_PROMPT,
      ),
    ).toBe(false);
  });
});

describe("api error recovery", () => {
  it("salvages a report from gathered evidence after a mid-loop api error", async () => {
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Doc\n\nThe answer is 42." },
      metadata: { title: "Doc" },
    }));
    let calls = 0;
    const messagesCreate = vi.fn(async (_input: ModelStepInput) => {
      calls += 1;
      if (calls === 1) {
        return messageWith([
          toolUse("f1", "fetch", { url: "https://example.com/a" }),
        ]);
      }
      if (calls === 2) {
        throw new Error("429 rate_limit_error");
      }
      return messageWith([
        {
          type: "text",
          text: "# Report\n\nThe answer is 42, per https://example.com/a.",
        },
      ]);
    });
    const ctx = createContext({ messagesCreate, scrape });

    const result = await runResearchLoop({
      ctx,
      query: "What is the answer?",
      maxToolCalls: 20,
    });

    const steps = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    expect(result.markdown).toContain("# Report");
    expect(result.finishReason).toContain("final report after api error");
    expect(steps.at(-1)?.tools).toBeUndefined();
  });

  it("does not attempt synthesis after an api error when no evidence was gathered", async () => {
    const messagesCreate = vi.fn(async (_input: ModelStepInput) => {
      throw new Error("429 rate_limit_error");
    });
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is the answer?",
      maxToolCalls: 20,
    });

    expect(result.markdown).toBe("");
    expect(result.finishReason).toBe("api error: 429 rate_limit_error");
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("graceful stop", () => {
  it("salvages a report from gathered evidence when a soft stop is requested", async () => {
    const stopController = new AbortController();
    const scrape = vi.fn(async () => {
      stopController.abort();
      return {
        content: { markdown: "# Doc\n\nThe answer is 42." },
        metadata: { title: "Doc" },
      };
    });
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([toolUse("f1", "fetch", { url: "https://example.com/a" })]),
      )
      .mockResolvedValueOnce(
        messageWith([
          {
            type: "text",
            text: "# Report\n\nThe answer is 42, per https://example.com/a.",
          },
        ]),
      );
    const ctx = createContext({ messagesCreate, scrape });
    ctx.deps.stopSignal = stopController.signal;

    const result = await runResearchLoop({
      ctx,
      query: "What is the answer?",
      maxToolCalls: 20,
    });

    const steps = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe("final report after stop requested");
    expect(result.markdown).toContain("# Report");
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(steps.at(-1)?.tools).toBeUndefined();
    expect(JSON.stringify(steps.at(-1)?.messages)).toContain(
      "Runtime limit reached: stop requested",
    );
  });

  it("attempts a final synthesis even if the soft stop arrives before any step", async () => {
    const stopController = new AbortController();
    stopController.abort();
    const messagesCreate = vi.fn(async (_input: ModelStepInput) =>
      messageWith([
        { type: "text", text: "# Report\n\nNo sources were gathered." },
      ]),
    );
    const ctx = createContext({ messagesCreate });
    ctx.deps.stopSignal = stopController.signal;

    const result = await runResearchLoop({
      ctx,
      query: "What is the answer?",
      maxToolCalls: 20,
    });

    const steps = messagesCreate.mock.calls.map(
      ([input]) => input as ModelStepInput,
    );
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(steps[0]?.tools).toBeUndefined();
    expect(result.finishReason).toBe("final report after stop requested");
    expect(result.markdown).toContain("# Report");
  });
});

describe("empty final response", () => {
  it("nudges once then accepts the report the model writes next", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValueOnce(
        messageWith([
          { type: "thinking", thinking: "thinking…", signature: "sig" },
        ]),
      )
      .mockResolvedValueOnce(finalReport());
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 5,
    });
    const secondRequest = messagesCreate.mock.calls[1]?.[0] as ModelStepInput;

    expect(result.finishReason).toBe("final report");
    expect(result.markdown).toContain("Test Report");
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(secondRequest.messages)).toContain(
      "ended your turn with no report text",
    );
  });

  it("gives up after a second empty turn", async () => {
    const messagesCreate = vi
      .fn()
      .mockResolvedValue(
        messageWith([
          { type: "thinking", thinking: "still nothing", signature: "sig" },
        ]),
      );
    const ctx = createContext({ messagesCreate });

    const result = await runResearchLoop({
      ctx,
      query: "What is Atlas?",
      maxToolCalls: 5,
    });

    expect(result.finishReason).toBe("empty final response");
    expect(result.markdown).toBe("");
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });
});
