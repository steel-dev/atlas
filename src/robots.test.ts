import { afterEach, describe, expect, it, vi } from "vitest";
import { basicFetch } from "./providers/fetch.js";
import { createRobotsCache, parseRobots, robotsAllows } from "./robots.js";

describe("parseRobots and robotsAllows", () => {
  it("applies prefix disallow rules with longest-match allow overrides", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /search\nAllow: /search/about",
      "atlasresearchbot",
    );
    expect(robotsAllows(rules, "/search")).toBe(false);
    expect(robotsAllows(rules, "/search/deep")).toBe(false);
    expect(robotsAllows(rules, "/search/about")).toBe(true);
    expect(robotsAllows(rules, "/other")).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /*.pdf$",
      "atlasresearchbot",
    );
    expect(robotsAllows(rules, "/doc.pdf")).toBe(false);
    expect(robotsAllows(rules, "/a/b/doc.pdf")).toBe(false);
    expect(robotsAllows(rules, "/doc.pdfx")).toBe(true);
  });

  it("matches adversarial wildcard patterns without catastrophic backtracking", () => {
    const pattern = `/${"a*".repeat(40)}b$`;
    const rules = parseRobots(
      `User-agent: *\nDisallow: ${pattern}`,
      "atlasresearchbot",
    );
    const path = `/${"a".repeat(6000)}`;
    const start = Date.now();
    const verdict = robotsAllows(rules, path);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(verdict).toBe(true);
  });

  it("ignores empty disallow values", () => {
    const rules = parseRobots("User-agent: *\nDisallow:", "atlasresearchbot");
    expect(robotsAllows(rules, "/anything")).toBe(true);
  });

  it("prefers the most specific matching agent group over the wildcard", () => {
    const text =
      "User-agent: atlas\nDisallow: /atlas-only\n\nUser-agent: *\nDisallow: /everyone";
    const ours = parseRobots(text, "atlasresearchbot");
    expect(robotsAllows(ours, "/atlas-only")).toBe(false);
    expect(robotsAllows(ours, "/everyone")).toBe(true);
    const generic = parseRobots(text, "someotherbot");
    expect(robotsAllows(generic, "/everyone")).toBe(false);
    expect(robotsAllows(generic, "/atlas-only")).toBe(true);
  });

  it("shares rules across stacked user-agent lines", () => {
    const rules = parseRobots(
      "User-agent: foo\nUser-agent: atlasresearchbot\nDisallow: /x",
      "atlasresearchbot",
    );
    expect(robotsAllows(rules, "/x")).toBe(false);
  });
});

describe("createRobotsCache", () => {
  function fetchStub(handler: (url: string) => Response | Promise<Response>): {
    impl: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }) as typeof fetch;
    return { impl, calls };
  }

  it("checks paths against the cached robots rules per origin", async () => {
    const { impl, calls } = fetchStub(
      () => new Response("User-agent: *\nDisallow: /private/", { status: 200 }),
    );
    const cache = createRobotsCache({
      agentToken: "atlasresearchbot",
      userAgent: "test-agent",
      fetchImpl: impl,
    });
    expect(await cache.allows("https://example.com/public")).toBe(true);
    expect(await cache.allows("https://example.com/private/x")).toBe(false);
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("allows everything when robots.txt is missing or unreachable", async () => {
    const missing = createRobotsCache({
      agentToken: "atlasresearchbot",
      userAgent: "test-agent",
      fetchImpl: fetchStub(() => new Response("nope", { status: 404 })).impl,
    });
    expect(await missing.allows("https://example.com/anything")).toBe(true);

    const broken = createRobotsCache({
      agentToken: "atlasresearchbot",
      userAgent: "test-agent",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(await broken.allows("https://example.com/anything")).toBe(true);
  });
});

describe("basicFetch politeness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses robots-disallowed URLs without fetching them", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /private", {
          status: 200,
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch);

    const provider = basicFetch();
    const result = await provider.fetch({
      url: "https://example.com/private/page",
      guardRedirect: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.note).toContain("robots_disallowed");
      expect(result.escalate).toBe(true);
    }
    expect(requested).toEqual(["https://example.com/robots.txt"]);
  });

  it("serializes direct fetches per domain but not across domains", async () => {
    const activeByHost = new Map<string, number>();
    let maxSameHost = 0;
    let maxTotal = 0;
    let activeTotal = 0;
    vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0]) => {
      const host = new URL(String(input)).host;
      const active = (activeByHost.get(host) ?? 0) + 1;
      activeByHost.set(host, active);
      activeTotal++;
      maxSameHost = Math.max(maxSameHost, active);
      maxTotal = Math.max(maxTotal, activeTotal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeByHost.set(host, active - 1);
      activeTotal--;
      return new Response("nope", { status: 404 });
    }) as typeof fetch);

    const provider = basicFetch();
    const allow = async (): Promise<{ ok: true }> => ({ ok: true });
    await Promise.all([
      provider.fetch({ url: "https://a.example.com/1", guardRedirect: allow }),
      provider.fetch({ url: "https://a.example.com/2", guardRedirect: allow }),
      provider.fetch({ url: "https://b.example.org/1", guardRedirect: allow }),
    ]);
    expect(maxSameHost).toBe(1);
    expect(maxTotal).toBeGreaterThan(1);
  });
});
