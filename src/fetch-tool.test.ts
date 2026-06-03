import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "./pdf-extract.js";
import { execFetch } from "./fetch-tool.js";
import { createToolTestContext } from "./test-harness.js";

vi.mock("./pdf-extract.js", () => ({
  extractPdfText: vi.fn(),
}));

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

describe("execFetch", () => {
  it("extracts static HTML directly, stores the document, and queues claim extraction", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          `<html><head><title>Direct HTML Source</title></head><body><main><h1>Direct HTML Source</h1><p>${"Static evidence from the original HTML page. ".repeat(5)}</p></main></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn();
    const ctx = createToolTestContext({ scrape });

    const outcome = await execFetch({ url: "https://example.com/static" }, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(outcome.text).toContain('"method": "html_direct"');
    expect(outcome.text).toContain("Static evidence from the original HTML");
    expect(ctx.store.fetchedSources[0]).toMatchObject({
      url: "https://example.com/static",
      title: "Direct HTML Source",
    });
    expect(ctx.queueSpy).toHaveBeenCalledTimes(1);
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "source_fetched",
        method: "html_direct",
      }),
    );
  });

  it("falls back to a browser render when the direct fetch fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("direct fetch unavailable");
    });
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "# Steel Fetch\n\nRendered browser content." },
      metadata: { title: "Steel Fetch" },
    }));
    const ctx = createToolTestContext({ scrape });

    const outcome = await execFetch({ url: "https://example.com/js-app" }, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(outcome.text).toContain('"method": "browser_cdp"');
    expect(outcome.text).toContain("network_error: direct fetch failed");
    expect(ctx.store.fetchedSources[0]).toMatchObject({
      url: "https://example.com/js-app",
      title: "Steel Fetch",
    });
  });

  it("rejects tiny error pages instead of storing them", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("<html><body>404</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: { markdown: "x" },
      metadata: { title: "Tiny" },
    }));
    const ctx = createToolTestContext({ scrape });

    const outcome = await execFetch({ url: "https://example.com/missing" }, ctx);

    expect(outcome.text).toContain("Fetch failed");
    expect(ctx.store.fetchedSources).toHaveLength(0);
    expect(ctx.queueSpy).not.toHaveBeenCalled();
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "source_error",
        error: expect.stringContaining("thin_content"),
      }),
    );
  });

  it("keeps suspicious but substantial pages with quality warnings", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("direct fetch unavailable");
    });
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: {
        markdown: `# Access check\n\nChecking your browser before continuing. ${"Real page content that is long enough to keep. ".repeat(30)}`,
      },
      metadata: { title: "Access check" },
    }));
    const ctx = createToolTestContext({ scrape });

    const outcome = await execFetch({ url: "https://example.com/wall" }, ctx);

    expect(ctx.store.fetchedSources).toHaveLength(1);
    expect(outcome.text).toContain("blocked_or_challenge");
  });

  it("shares one in-flight extraction between duplicate parallel fetches", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("direct disabled");
    });
    vi.stubGlobal("fetch", fetch);
    let scrapeCalls = 0;
    const scrape = vi.fn(async () => {
      scrapeCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        content: {
          markdown: `# Shared\n\n${"Shared body content. ".repeat(20)}`,
        },
        metadata: { title: "Shared" },
      };
    });
    const ctx = createToolTestContext({ scrape });

    const [first, second] = await Promise.all([
      execFetch({ url: "https://example.com/dup" }, ctx),
      execFetch({ url: "https://example.com/dup" }, ctx),
    ]);

    expect(scrapeCalls).toBe(1);
    expect(ctx.store.fetchedSources).toHaveLength(1);
    expect(first.text).toContain("source_1");
    expect(second.text).toContain("source_1");
  });

  it("fetches url batches in parallel and reports per-url outcomes", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          `<html><head><title>${String(url)}</title></head><body><main><p>${"Body text for the batch fetch case. ".repeat(20)}</p></main></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const ctx = createToolTestContext({ sourceCap: 10 });

    const outcome = await execFetch(
      {
        urls: ["https://example.com/one", "https://example.com/two"],
      },
      ctx,
    );

    expect(outcome.fetchedUrls).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
    expect(ctx.store.fetchedSources).toHaveLength(2);
    expect(ctx.queueSpy).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(outcome.text) as { sources: unknown[] };
    expect(payload.sources).toHaveLength(2);
  });

  it("routes direct fetches through proxied steel scrape when proxy is on", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("direct should not be used with proxy");
    });
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: {
        markdown: `# Proxied\n\n${"Proxied page content. ".repeat(20)}`,
      },
      metadata: { title: "Proxied" },
    }));
    const ctx = createToolTestContext({ scrape, useProxy: true });

    const outcome = await execFetch({ url: "https://example.com/geo" }, ctx);

    expect(fetch).not.toHaveBeenCalled();
    expect(scrape).toHaveBeenCalled();
    expect(outcome.text).toContain('"method": "scrape_proxy"');
  });

  it("returns the existing source card for an already-fetched url", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          `<html><head><title>Once</title></head><body><main><p>${"Fetched once only. ".repeat(20)}</p></main></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const ctx = createToolTestContext({});

    await execFetch({ url: "https://example.com/once" }, ctx);
    const second = await execFetch({ url: "https://example.com/once" }, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.store.fetchedSources).toHaveLength(1);
    expect(second.text).toContain("source_1");
    expect(ctx.queueSpy).toHaveBeenCalledTimes(1);
  });
});
