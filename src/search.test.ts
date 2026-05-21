import { describe, expect, it } from "vitest";
import { __testing, safeDomain } from "./search.js";

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
});
