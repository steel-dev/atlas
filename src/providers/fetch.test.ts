import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basicFetch,
  looksBlockedPage,
  type SteelScrapeResponse,
  steelAttemptFromResponse,
} from "./fetch.js";

const PAGE_BODY =
  "<html><head><title>Tower</title></head><body><p>" +
  "The tower stands at 330 meters tall according to the official register. ".repeat(
    4,
  ) +
  "</p></body></html>";

describe("basicFetch redirect handling", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/start") {
        res.writeHead(302, { location: "/target" });
        res.end();
        return;
      }
      if (req.url === "/hop") {
        res.writeHead(302, { location: "http://127.0.0.1:9/private" });
        res.end();
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      }
      if (req.url === "/target") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE_BODY);
        return;
      }
      if (req.url === "/badpdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("%PDF-1.4 this is not a parseable pdf body");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("follows redirects hop by hop through the guard", async () => {
    const provider = basicFetch();
    const guarded: string[] = [];
    const result = await provider.fetch({
      url: `${base}/start`,
      guardRedirect: async (url) => {
        guarded.push(url);
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(guarded).toEqual([`${base}/target`]);
    if (result.ok) {
      expect(result.page.markdown).toContain("330 meters tall");
    }
  });

  it("blocks a redirect the guard rejects", async () => {
    const provider = basicFetch();
    const result = await provider.fetch({
      url: `${base}/hop`,
      guardRedirect: async () => ({
        ok: false,
        reason: "address is private or reserved",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.note).toContain("blocked_redirect");
      expect(result.attempt.note).toContain("private or reserved");
    }
  });

  it("blocks a private initial URL when used standalone without a guard", async () => {
    const provider = basicFetch();
    const result = await provider.fetch({ url: `${base}/target` });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.note).toContain("blocked_url");
    }
  });

  it("gives up on redirect loops", async () => {
    const provider = basicFetch();
    const result = await provider.fetch({
      url: `${base}/loop`,
      guardRedirect: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.note).toContain("too_many_redirects");
    }
  });

  it("escalates a PDF that fails to parse so the chain can fall back", async () => {
    const provider = basicFetch();
    const result = await provider.fetch({
      url: `${base}/badpdf`,
      guardRedirect: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.note).toMatch(/pdf_(no_text|parse_error)/);
      expect(result.escalate).toBe(true);
    }
  });
});

describe("steelAttemptFromResponse", () => {
  const article = "Land reform reshaped tenure across the region. ".repeat(8);

  it("uses scraped html when it is substantive", () => {
    const response: SteelScrapeResponse = {
      content: { html: `<html><body><p>${article}</p></body></html>` },
    };
    const result = steelAttemptFromResponse(response, "https://x.com/a");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.renderedWith).toBe("steel_scrape");
      expect(result.page.markdown).toContain("Land reform");
    }
  });

  it("falls through to markdown when the html is a thin pdf viewer shell", () => {
    const response: SteelScrapeResponse = {
      content: {
        html: "<html><body><div id=viewer></div></body></html>",
        markdown: `# Report\n\n${article}`,
      },
    };
    const result = steelAttemptFromResponse(response, "https://x.com/a.pdf");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.renderedWith).toBe("steel_scrape");
      expect(result.page.markdown).toContain("Land reform");
    }
  });

  it("falls through to markdown when the html looks blocked", () => {
    const response: SteelScrapeResponse = {
      content: {
        html: "<html><body><h1>Just a moment...</h1><p>Enable JavaScript and cookies to continue.</p></body></html>",
        markdown: article,
      },
    };
    const result = steelAttemptFromResponse(response, "https://x.com/a.pdf");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.page.markdown).toContain("Land reform");
  });

  it("fails when neither html nor markdown is usable", () => {
    const response: SteelScrapeResponse = {
      content: { html: "<html><body><p>hi</p></body></html>" },
    };
    const result = steelAttemptFromResponse(response, "https://x.com/a.pdf");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempt.note).toContain("empty_content");
  });

  it("fails on an http error status", () => {
    const response: SteelScrapeResponse = {
      content: { markdown: article },
      metadata: { statusCode: 403 },
    };
    const result = steelAttemptFromResponse(response, "https://x.com/a.pdf");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.note).toContain("http_error");
      expect(result.escalate).toBe(false);
    }
  });
});

describe("looksBlockedPage", () => {
  it("flags a thin challenge page", () => {
    const raw =
      "<html><body><h1>Just a moment...</h1><p>Enable JavaScript and cookies to continue.</p></body></html>";
    expect(
      looksBlockedPage(
        "Just a moment... Enable JavaScript and cookies to continue.",
        raw,
      ),
    ).toBe(true);
  });

  it("ignores marker words in the raw HTML of a substantive page", () => {
    const raw =
      '<html><head><script>{"wgConfirmEditCaptchaNeededForGenericEdit":"hcaptcha"}</script></head><body>article</body></html>';
    const markdown =
      "Land reform in Zimbabwe began in earnest in 2000. ".repeat(60);
    expect(looksBlockedPage(markdown, raw)).toBe(false);
  });

  it("ignores marker words in the body of a substantive page", () => {
    const markdown =
      "This article explains how captcha challenges and access denied responses work. ".repeat(
        40,
      );
    expect(looksBlockedPage(markdown)).toBe(false);
  });
});
