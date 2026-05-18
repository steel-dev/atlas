import { describe, expect, it } from "vitest";
import {
  canonicalKey,
  discoverSitemapCandidates,
  filterCandidates,
  isDisallowedByRobots,
  normalizeUrl,
  parseRobotsTxt,
  passesFilter,
  type CrawlFilterOptions,
  type RobotsRules,
} from "./crawl";

describe("normalizeUrl", () => {
  it("returns null for non-http(s) schemes", () => {
    expect(normalizeUrl("mailto:foo@bar.com")).toBeNull();
    expect(normalizeUrl("ftp://example.com")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
  });

  it("strips ordinary hash fragments", () => {
    expect(normalizeUrl("https://x.com/page#fragment")).toBe("https://x.com/page");
  });

  it("preserves SPA-style #/ hashes", () => {
    expect(normalizeUrl("https://x.com/page#/spa/route")).toBe(
      "https://x.com/page#/spa/route",
    );
  });

  it("strips query when ignoreQueryParameters=true", () => {
    expect(
      normalizeUrl("https://x.com/page?a=1&b=2", { ignoreQueryParameters: true }),
    ).toBe("https://x.com/page");
  });

  it("keeps query by default", () => {
    expect(normalizeUrl("https://x.com/page?a=1")).toBe("https://x.com/page?a=1");
  });

  it("returns null for invalid input", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
  });
});

describe("canonicalKey", () => {
  it("collapses www/non-www + http/https to a single key", () => {
    const k1 = canonicalKey("https://example.com/page");
    const k2 = canonicalKey("http://www.example.com/page");
    expect(k1).toBe(k2);
  });

  it("differentiates distinct paths", () => {
    expect(canonicalKey("https://example.com/a")).not.toBe(
      canonicalKey("https://example.com/b"),
    );
  });

  it("normalizes scheme to https", () => {
    expect(canonicalKey("http://example.com/x")).toBe("https://example.com/x");
  });

  it("collapses /foo, /foo/, /foo/index.html to one key", () => {
    const k = canonicalKey("https://example.com/foo");
    expect(canonicalKey("https://example.com/foo/")).toBe(k);
    expect(canonicalKey("https://example.com/foo/index.html")).toBe(k);
    expect(canonicalKey("https://example.com/foo/index.php")).toBe(k);
  });

  it("keeps root '/' as-is", () => {
    expect(canonicalKey("https://example.com/")).toBe("https://example.com/");
  });

  it("preserves query and SPA hash", () => {
    expect(canonicalKey("https://example.com/p?a=1")).toBe("https://example.com/p?a=1");
    expect(canonicalKey("https://example.com/p#/route")).toBe("https://example.com/p#/route");
  });

  it("returns input unchanged for invalid URLs", () => {
    expect(canonicalKey("not a url")).toBe("not a url");
  });
});

describe("parseRobotsTxt", () => {
  it("collects disallows from User-agent: * group", () => {
    const text = "User-agent: *\nDisallow: /private\nDisallow: /admin\n";
    expect(parseRobotsTxt(text).disallows).toEqual(["/private", "/admin"]);
  });

  it("ignores disallows from specific user-agent groups", () => {
    const text =
      "User-agent: Googlebot\nDisallow: /no-google\nUser-agent: *\nDisallow: /everyone\n";
    expect(parseRobotsTxt(text).disallows).toEqual(["/everyone"]);
  });

  it("collects Sitemap URLs regardless of user-agent", () => {
    const text =
      "User-agent: Googlebot\nSitemap: https://x.com/s1.xml\nUser-agent: *\nSitemap: https://x.com/s2.xml\n";
    expect(parseRobotsTxt(text).sitemaps).toEqual([
      "https://x.com/s1.xml",
      "https://x.com/s2.xml",
    ]);
  });

  it("strips comments", () => {
    const text = "# header comment\nUser-agent: *\nDisallow: /a # inline\n";
    expect(parseRobotsTxt(text).disallows).toEqual(["/a"]);
  });

  it("returns empty rules for empty input", () => {
    expect(parseRobotsTxt("")).toEqual({ disallows: [], sitemaps: [] });
  });
});

describe("isDisallowedByRobots", () => {
  it("returns false when rules are null", () => {
    expect(isDisallowedByRobots("https://x.com/foo", null)).toBe(false);
  });

  it("blocks paths matching a Disallow prefix", () => {
    const rules: RobotsRules = { disallows: ["/admin"], sitemaps: [] };
    expect(isDisallowedByRobots("https://x.com/admin", rules)).toBe(true);
    expect(isDisallowedByRobots("https://x.com/admin/users", rules)).toBe(true);
    expect(isDisallowedByRobots("https://x.com/public", rules)).toBe(false);
  });

  it("treats Disallow: / as 'block everything'", () => {
    const rules: RobotsRules = { disallows: ["/"], sitemaps: [] };
    expect(isDisallowedByRobots("https://x.com/anything", rules)).toBe(true);
  });

  it("returns false for malformed URLs (degrades safely)", () => {
    const rules: RobotsRules = { disallows: ["/"], sitemaps: [] };
    expect(isDisallowedByRobots("not a url", rules)).toBe(false);
  });
});

describe("discoverSitemapCandidates", () => {
  it("includes Sitemap URLs declared in robots.txt", () => {
    const rules: RobotsRules = {
      disallows: [],
      sitemaps: ["https://x.com/custom-sitemap.xml"],
    };
    const cands = discoverSitemapCandidates("https://x.com/start", rules);
    expect(cands).toContain("https://x.com/custom-sitemap.xml");
  });

  it("always includes /sitemap.xml at the host root", () => {
    const cands = discoverSitemapCandidates("https://x.com/foo", null);
    expect(cands).toContain("https://x.com/sitemap.xml");
  });

  it("caps total candidates at 20", () => {
    const sitemaps = Array.from({ length: 50 }, (_, i) => `https://x.com/sm${i}.xml`);
    const cands = discoverSitemapCandidates("https://x.com/", { disallows: [], sitemaps });
    expect(cands.length).toBeLessThanOrEqual(20);
  });
});

describe("passesFilter — 9-step chain", () => {
  const base: CrawlFilterOptions = {
    initialUrl: "https://example.com/start",
    excludePaths: [],
    includePaths: [],
    crawlEntireDomain: true,
    allowSubdomains: false,
    allowExternalLinks: false,
    regexOnFullURL: false,
    robotsRules: null,
  };

  it("drops non-http(s) protocols", () => {
    expect(passesFilter("mailto:a@b.com", base)).toBe(false);
    expect(passesFilter("javascript:void(0)", base)).toBe(false);
    expect(passesFilter("ftp://example.com", base)).toBe(false);
  });

  it("enforces maxDepth by path-segment count", () => {
    expect(passesFilter("https://example.com/a/b/c", { ...base, maxDepth: 2 })).toBe(false);
    expect(passesFilter("https://example.com/a/b", { ...base, maxDepth: 2 })).toBe(true);
  });

  it("blocks external domains by default", () => {
    expect(passesFilter("https://other.com/a", base)).toBe(false);
    expect(passesFilter("https://example.com/a", base)).toBe(true);
  });

  it("treats www.example.com and example.com as same host", () => {
    expect(passesFilter("https://www.example.com/a", base)).toBe(true);
  });

  it("allowSubdomains widens to registrable-domain neighbors", () => {
    expect(
      passesFilter("https://blog.example.com/x", { ...base, allowSubdomains: true }),
    ).toBe(true);
    expect(
      passesFilter("https://blog.other.com/x", { ...base, allowSubdomains: true }),
    ).toBe(false);
  });

  it("allowExternalLinks lets anything through", () => {
    expect(
      passesFilter("https://random.io/a", { ...base, allowExternalLinks: true }),
    ).toBe(true);
  });

  it("enforces backward-crawl gate when crawlEntireDomain=false", () => {
    const opts: CrawlFilterOptions = {
      ...base,
      initialUrl: "https://example.com/docs/",
      crawlEntireDomain: false,
    };
    expect(passesFilter("https://example.com/docs/page", opts)).toBe(true);
    expect(passesFilter("https://example.com/blog/page", opts)).toBe(false);
  });

  it("applies excludePaths regex against pathname", () => {
    expect(
      passesFilter("https://example.com/admin/x", { ...base, excludePaths: ["^/admin"] }),
    ).toBe(false);
    expect(
      passesFilter("https://example.com/docs/x", { ...base, excludePaths: ["^/admin"] }),
    ).toBe(true);
  });

  it("requires includePaths match when list non-empty", () => {
    expect(
      passesFilter("https://example.com/docs/a", { ...base, includePaths: ["^/docs"] }),
    ).toBe(true);
    expect(
      passesFilter("https://example.com/blog/a", { ...base, includePaths: ["^/docs"] }),
    ).toBe(false);
  });

  it("regexOnFullURL switches target to full URL", () => {
    expect(
      passesFilter("https://example.com/a", {
        ...base,
        excludePaths: ["^https://example\\.com/a$"],
        regexOnFullURL: true,
      }),
    ).toBe(false);
  });

  it("respects robots.txt rules", () => {
    const rules: RobotsRules = { disallows: ["/private"], sitemaps: [] };
    expect(
      passesFilter("https://example.com/private", { ...base, robotsRules: rules }),
    ).toBe(false);
    expect(
      passesFilter("https://example.com/public", { ...base, robotsRules: rules }),
    ).toBe(true);
  });

  it("drops resource file extensions but keeps documents", () => {
    expect(passesFilter("https://example.com/style.css", base)).toBe(false);
    expect(passesFilter("https://example.com/photo.jpg", base)).toBe(false);
    expect(passesFilter("https://example.com/doc.pdf", base)).toBe(true);
    expect(passesFilter("https://example.com/page", base)).toBe(true);
  });

  it("handles malformed URLs", () => {
    expect(passesFilter("not a url", base)).toBe(false);
  });
});

describe("filterCandidates", () => {
  const opts: CrawlFilterOptions = {
    initialUrl: "https://example.com/",
    excludePaths: [],
    includePaths: [],
    crawlEntireDomain: true,
    allowSubdomains: false,
    allowExternalLinks: false,
    regexOnFullURL: false,
    robotsRules: null,
  };

  it("dedupes identical URLs", () => {
    const out = filterCandidates(
      ["https://example.com/a", "https://example.com/a", "https://example.com/b"],
      opts,
    );
    expect(out.length).toBe(2);
  });

  it("normalizes URLs (hash variants collapse)", () => {
    const out = filterCandidates(
      ["https://example.com/a#foo", "https://example.com/a#bar"],
      opts,
    );
    expect(out.length).toBe(1);
  });

  it("drops invalid URLs silently", () => {
    const out = filterCandidates(["not a url", "https://example.com/ok"], opts);
    expect(out).toEqual(["https://example.com/ok"]);
  });

  it("strips query strings when ignoreQueryParameters=true", () => {
    const out = filterCandidates(
      ["https://example.com/a?x=1", "https://example.com/a?y=2"],
      { ...opts, ignoreQueryParameters: true },
    );
    expect(out).toEqual(["https://example.com/a"]);
  });

  it("keeps distinct query strings by default", () => {
    const out = filterCandidates(
      ["https://example.com/a?x=1", "https://example.com/a?y=2"],
      opts,
    );
    expect(out.length).toBe(2);
  });
});
