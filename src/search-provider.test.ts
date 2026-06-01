import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBraveSearchProvider,
  createExaSearchProvider,
  resolveSearchProvider,
  type SearchProvider,
} from "./search-provider.js";
import { execSearch } from "./search-tool.js";
import { createAgentScope, type ResearchCtx } from "./runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctxWithProvider(provider: SearchProvider): ResearchCtx {
  return {
    config: { useProxy: false, defaultSearchLimit: 5 },
    deps: { searchProvider: provider },
    scope: createAgentScope({ sink: () => undefined }),
  } as unknown as ResearchCtx;
}

function headerValue(init: RequestInit | undefined, name: string): string {
  return (init?.headers as Record<string, string> | undefined)?.[name] ?? "";
}

describe("SearchProvider seam", () => {
  it("execSearch uses an injected provider and surfaces its results", async () => {
    const provider: SearchProvider = {
      name: "fake",
      searchQuery: vi.fn(async ({ query }) => ({
        query,
        sources: [
          {
            source: "fake",
            order: 0,
            results: [
              {
                position: 1,
                title: "Doc A",
                url: "https://example.com/a",
                snippet: "snippet a",
                domain: "example.com",
              },
              {
                position: 2,
                title: "Doc B",
                url: "https://example.com/b",
                snippet: "snippet b",
                domain: "example.com",
              },
            ],
          },
        ],
        attempted: ["fake"],
        warnings: [],
        sawEmptyResults: false,
      })),
    };
    const ctx = ctxWithProvider(provider);

    const payload = JSON.parse(await execSearch({ query: "q" }, ctx, 1)) as {
      provider: string;
      engines: string[];
      searched_engines: string[];
      results: Array<{
        rank: number;
        url: string;
        engine: string;
        engine_rank: number;
        engines: string[];
      }>;
    };

    expect(provider.searchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ query: "q", limit: 5 }),
    );
    expect(payload.provider).toBe("fake");
    expect(payload.engines).toEqual(["fake"]);
    expect(payload.searched_engines).toEqual(["fake"]);
    expect(payload.results.map((result) => result.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(payload.results[0]).toMatchObject({
      rank: 1,
      engine: "fake",
      engine_rank: 1,
      engines: ["fake"],
    });
  });
});

describe("Exa provider", () => {
  it("posts to the Exa API and parses highlights into snippets", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Exa Result",
                url: "https://example.com/exa",
                highlights: ["First highlight.", "Second highlight."],
              },
              { title: "No URL" },
              {
                title: "Text only",
                url: "https://example.com/t",
                text: "Body text here.",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createExaSearchProvider({ apiKey: "exa-key" });
    const outcome = await provider.searchQuery({
      query: "deep research",
      limit: 5,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(provider.name).toBe("exa");
    expect(String(url)).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    expect(headerValue(init, "x-api-key")).toBe("exa-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "deep research",
      numResults: 5,
    });
    expect(outcome.attempted).toEqual(["exa"]);
    expect(outcome.sources[0]?.source).toBe("exa");
    expect(outcome.sources[0]?.results.map((result) => result.url)).toEqual([
      "https://example.com/exa",
      "https://example.com/t",
    ]);
    expect(outcome.sources[0]?.results[0]?.snippet).toBe(
      "First highlight. … Second highlight.",
    );
    expect(outcome.sources[0]?.results[1]?.snippet).toBe("Body text here.");
  });

  it("reports HTTP errors as warnings instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const provider = createExaSearchProvider({ apiKey: "bad" });
    const outcome = await provider.searchQuery({ query: "q", limit: 5 });

    expect(outcome.sources).toEqual([]);
    expect(outcome.warnings[0]).toContain("exa: HTTP 401");
  });
});

describe("Brave provider", () => {
  it("GETs the Brave API and parses web results", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Brave Result",
                  url: "https://example.com/brave",
                  description: "A description.",
                },
                {
                  title: "Snippets",
                  url: "https://example.com/s",
                  extra_snippets: ["x", "y"],
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createBraveSearchProvider({ apiKey: "brave-key" });
    const outcome = await provider.searchQuery({ query: "news", limit: 3 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      "https://api.search.brave.com/res/v1/web/search?",
    );
    expect(String(url)).toContain("q=news");
    expect(String(url)).toContain("count=3");
    expect(headerValue(init, "x-subscription-token")).toBe("brave-key");
    expect(outcome.sources[0]?.results.map((result) => result.url)).toEqual([
      "https://example.com/brave",
      "https://example.com/s",
    ]);
    expect(outcome.sources[0]?.results[0]?.snippet).toBe("A description.");
    expect(outcome.sources[0]?.results[1]?.snippet).toBe("x … y");
  });
});

describe("resolveSearchProvider", () => {
  const ctx = {} as ResearchCtx;

  it("defaults to the scraping provider", () => {
    expect(resolveSearchProvider(ctx, {}).name).toBe("web");
    expect(resolveSearchProvider(ctx, { kind: "web" }).name).toBe("web");
  });

  it("returns an explicit instance over a named kind", () => {
    const fake = { name: "fake", searchQuery: vi.fn() } as SearchProvider;
    expect(resolveSearchProvider(ctx, { instance: fake, kind: "exa" })).toBe(
      fake,
    );
  });

  it("constructs named API providers when keys are present", () => {
    expect(
      resolveSearchProvider(ctx, { kind: "exa", exaApiKey: "k" }).name,
    ).toBe("exa");
    expect(
      resolveSearchProvider(ctx, { kind: "brave", braveApiKey: "k" }).name,
    ).toBe("brave");
  });

  it("throws on missing keys and unknown providers", () => {
    expect(() => resolveSearchProvider(ctx, { kind: "exa" })).toThrow(
      /EXA_API_KEY/,
    );
    expect(() => resolveSearchProvider(ctx, { kind: "brave" })).toThrow(
      /BRAVE_API_KEY/,
    );
    expect(() => resolveSearchProvider(ctx, { kind: "nope" })).toThrow(
      /unknown search provider/,
    );
  });
});
