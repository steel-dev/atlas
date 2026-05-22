import type Steel from "steel-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, safeDomain, webSearch } from "./search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SERP parsing", () => {
  it("parses DuckDuckGo results and unwraps redirect URLs", () => {
    const target = "https://example.com/research?x=1";
    const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`;
    const html = `
      <div class="result">
        <a class="result__a" href="${href}">Example Research</a>
        <a class="result__snippet">A useful snippet.</a>
      </div>
    `;

    const results = __testing.parseSerp("ddg", html, 5);

    expect(results).toEqual([
      {
        position: 1,
        title: "Example Research",
        url: target,
        snippet: "A useful snippet.",
        domain: "example.com",
      },
    ]);
  });

  it("parses Bing results", () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.org/paper">Paper</a></h2>
        <div class="b_caption"><p>Paper snippet.</p></div>
      </li>
    `;

    const results = __testing.parseSerp("bing", html, 5);

    expect(results[0]).toMatchObject({
      position: 1,
      title: "Paper",
      url: "https://example.org/paper",
      snippet: "Paper snippet.",
      domain: "example.org",
    });
  });

  it("parses Google results and normalizes outbound URLs", () => {
    const target = "https://example.net/docs";
    const html = `
      <div class="g">
        <a href="/url?q=${encodeURIComponent(target)}&sa=U"><h3>Docs</h3></a>
        <div class="VwiC3b">Docs snippet.</div>
      </div>
    `;

    const results = __testing.parseSerp("google", html, 5);

    expect(results[0]).toMatchObject({
      position: 1,
      title: "Docs",
      url: target,
      snippet: "Docs snippet.",
      domain: "example.net",
    });
  });

  it("builds engine-specific SERP URLs", () => {
    expect(__testing.buildSerpUrl("google", "atlas research", {
      country: "US",
      lang: "en",
      limit: 10,
    })).toBe("https://www.google.com/search?q=atlas+research&num=15&gl=us&hl=en");
  });

  it("extracts domains defensively", () => {
    expect(safeDomain("https://www.example.com/path")).toBe("example.com");
    expect(safeDomain("not a url")).toBe("");
  });

  it("uses plain HTTP for SERP fetches before Steel", async () => {
    const fetch = vi.fn(async () =>
      new Response(`
        <div class="result">
          <a class="result__a" href="https://example.com/plain">Plain Result</a>
          <a class="result__snippet">Plain snippet.</a>
        </div>
      `, {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn();

    const outcome = await webSearch({
      steel: { scrape } as unknown as Steel,
      query: "plain query",
      engine: "ddg",
    });

    expect(outcome).toEqual({
      ok: true,
      results: [
        {
          position: 1,
          title: "Plain Result",
          url: "https://example.com/plain",
          snippet: "Plain snippet.",
          domain: "example.com",
        },
      ],
    });
    expect(scrape).not.toHaveBeenCalled();
  });

  it("falls back to Steel when plain SERP fetch is blocked", async () => {
    const fetch = vi.fn(async () =>
      new Response("enable javascript and cookies", {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const scrape = vi.fn(async () => ({
      content: {
        html: `
          <div class="result">
            <a class="result__a" href="https://example.com/steel">Steel Result</a>
            <a class="result__snippet">Steel snippet.</a>
          </div>
        `,
      },
      metadata: {},
    }));

    const outcome = await webSearch({
      steel: { scrape } as unknown as Steel,
      query: "blocked query",
      engine: "ddg",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.results[0]?.url).toBe("https://example.com/steel");
    }
    expect(scrape).toHaveBeenCalledTimes(1);
  });
});
