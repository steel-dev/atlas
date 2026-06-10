import { afterEach, describe, expect, it, vi } from "vitest";
import { arxiv } from "./arxiv.js";
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
  it("adds canonical https sources with abstract content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ATOM, { status: 200 })),
    );
    const { ctx, sources } = makeCtx();
    const out = await arxiv().execute({ query: "transformers" }, ctx);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://arxiv.org/abs/2301.00001v1");
    expect(sources[0].title).toBe("Attention Variants");
    expect(sources[0].content).toContain("Authors: Ada Lovelace, Alan Turing");
    expect(sources[0].content).toContain(
      "We propose a new transformer variant.",
    );
    expect(out).toContain("found 2 result");
  });

  it("forwards signal and applies defaultLimit", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(ATOM, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const { ctx } = makeCtx(controller.signal);
    await arxiv({ defaultLimit: 7 }).execute({ query: "x" }, ctx);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain("max_results=7");
    expect((call[1] as RequestInit).signal).toBe(controller.signal);
  });

  it("returns a message and adds nothing on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 503 })),
    );
    const { ctx, sources } = makeCtx();
    const out = await arxiv().execute({ query: "x" }, ctx);
    expect(sources).toHaveLength(0);
    expect(out).toContain("failed");
  });
});
