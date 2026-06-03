import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSearch } from "./search-tool.js";
import { createToolTestContext } from "./test-harness.js";

const DDG_HTML = `
  <div class="result">
    <a class="result__a" href="https://example.com/result">Result</a>
    <a class="result__snippet">Snippet.</a>
  </div>
`;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("test direct fetch disabled");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("execSearch", () => {
  it("reuses cached SERPs across repeated identical queries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("enable javascript and cookies", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const scrape = vi.fn(async () => ({
      content: { html: DDG_HTML },
      metadata: {},
    }));
    const ctx = createToolTestContext({ scrape });

    const first = await execSearch({ query: "same query" }, ctx, 0);
    const second = await execSearch({ query: "same query" }, ctx, 1);

    expect(first).toContain('"results"');
    expect(second).toContain('"results"');
    expect(scrape).toHaveBeenCalledTimes(3);
    expect(ctx.store.caches.serp.size).toBe(3);
  });

  it("returns rank provenance from the engines that responded", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        return new Response(
          `<html><body><div class="result"><a class="result__a" href="https://example.com/ddg-one">DDG One</a><a class="result__snippet">First DDG snippet.</a></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>Unexpected engine</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const ctx = createToolTestContext({});

    const text = await execSearch({ query: "selected query" }, ctx, 0);
    const payload = JSON.parse(text) as {
      engines: string[];
      searched_engines: string[];
      results: Array<Record<string, unknown>>;
    };

    expect(payload.engines).toEqual(["ddg"]);
    expect(payload.searched_engines).toEqual(["ddg", "bing", "google"]);
    expect(payload.results[0]).toMatchObject({
      rank: 1,
      title: "DDG One",
      url: "https://example.com/ddg-one",
      engine: "ddg",
      engine_rank: 1,
    });
  });

  it("merges batched query variants into one ranked list", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("duckduckgo.com")) {
        const target = href.includes(encodeURIComponent("variant two"))
          ? `<div class="result"><a class="result__a" href="https://example.com/shared">Shared</a><a class="result__snippet">From two.</a></div>`
          : `<div class="result"><a class="result__a" href="https://example.com/shared">Shared</a><a class="result__snippet">From one.</a></div><div class="result"><a class="result__a" href="https://example.com/only-one">Only One</a><a class="result__snippet">Unique.</a></div>`;
        return new Response(`<html><body>${target}</body></html>`, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("<html><body></body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const ctx = createToolTestContext({});

    const text = await execSearch(
      { queries: ["variant one", "variant two"] },
      ctx,
      0,
    );
    const payload = JSON.parse(text) as {
      results: Array<{ url: string; queries?: string[] }>;
    };

    expect(payload.results[0]?.url).toBe("https://example.com/shared");
    expect(payload.results[0]?.queries).toEqual([
      "variant one",
      "variant two",
    ]);
  });

  it("rejects calls without a usable query", async () => {
    const ctx = createToolTestContext({});
    const text = await execSearch({}, ctx, 0);
    expect(text).toContain("Error: search requires");
  });
});
