import { afterEach, describe, expect, it, vi } from "vitest";
import { arxiv } from "./arxiv.js";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>Attention Variants</title>
    <summary>  We propose a new
    transformer variant.  </summary>
    <published>2023-01-01T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.00002v2</id>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <published>2023-02-02T00:00:00Z</published>
    <author><name>Grace Hopper</name></author>
  </entry>
</feed>`;

afterEach(() => vi.unstubAllGlobals());

describe("arxiv", () => {
  it("returns canonical https results with abstract snippet and pdf openUrls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ATOM, { status: 200 })),
    );
    const results = await arxiv().search({ query: "transformers" });
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://arxiv.org/abs/2301.00001v1");
    expect(results[0].title).toBe("Attention Variants");
    expect(results[0].snippet).toContain("We propose a new transformer variant.");
    expect(results[0].meta?.openUrls).toContain(
      "https://arxiv.org/pdf/2301.00001v1",
    );
    const fallback = String(results[0].meta?.fallbackText);
    expect(fallback).toContain("Authors: Ada Lovelace, Alan Turing");
  });

  it("forwards signal and applies defaultLimit", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(ATOM, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await arxiv({ defaultLimit: 7 }).search({
      query: "x",
      signal: controller.signal,
    });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain("max_results=7");
    expect((call[1] as RequestInit).signal).toBe(controller.signal);
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 503 })),
    );
    await expect(arxiv().search({ query: "x" })).rejects.toThrow(/failed/);
  });
});
