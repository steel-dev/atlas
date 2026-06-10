import { afterEach, describe, expect, it, vi } from "vitest";
import { wikipedia } from "./wikipedia.js";
import type { ToolContext } from "../../src/custom-tools.js";

function makeCtx(signal?: AbortSignal) {
  const sources: { url: string; title?: string; content: string }[] = [];
  const ctx: ToolContext = {
    addSource: (s) => sources.push(s),
    signal,
    log: () => {},
  };
  return { ctx, sources };
}

const RESP = JSON.stringify({
  query: {
    pages: [
      { pageid: 2, title: "Beta Topic", extract: "Beta is second.", index: 2 },
      { pageid: 1, title: "Alpha Topic", extract: "Alpha is first.", index: 1 },
    ],
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("wikipedia", () => {
  it("orders by search rank and builds canonical wiki URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(RESP, { status: 200 })),
    );
    const { ctx, sources } = makeCtx();
    const out = await wikipedia().execute({ query: "topic" }, ctx);
    expect(sources.map((s) => s.title)).toEqual(["Alpha Topic", "Beta Topic"]);
    expect(sources[0].url).toBe("https://en.wikipedia.org/wiki/Alpha_Topic");
    expect(sources[0].content).toContain("Alpha is first.");
    expect(out).toContain("found 2 result");
  });

  it("uses lang and gsrlimit from options", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(RESP, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    await wikipedia({ lang: "de", defaultLimit: 4 }).execute({ query: "x" }, ctx);
    const u = String(fetchMock.mock.calls[0][0]);
    expect(u).toContain("https://de.wikipedia.org/w/api.php");
    expect(u).toContain("gsrlimit=4");
    expect(u).toContain("generator=search");
  });
});
