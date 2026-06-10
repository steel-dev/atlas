import { afterEach, describe, expect, it, vi } from "vitest";
import { openalex } from "./openalex.js";
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
  results: [
    {
      id: "https://openalex.org/W1",
      title: "On Widgets",
      doi: "https://doi.org/10.1/abc",
      publication_year: 2021,
      cited_by_count: 42,
      primary_location: { source: { display_name: "Widget Journal" } },
      authorships: [{ author: { display_name: "Jane Smith" } }],
      abstract_inverted_index: { The: [0], widget: [1], works: [2] },
    },
  ],
});

afterEach(() => vi.unstubAllGlobals());

describe("openalex", () => {
  it("reconstructs abstracts and prefers the DOI url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(RESP, { status: 200 })),
    );
    const { ctx, sources } = makeCtx();
    const out = await openalex().execute({ query: "widgets" }, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://doi.org/10.1/abc");
    expect(sources[0].content).toContain("The widget works");
    expect(sources[0].content).toContain("Authors: Jane Smith");
    expect(sources[0].content).toContain("Widget Journal (2021)");
    expect(sources[0].content).toContain("Cited by 42");
    expect(out).toContain("found 1 result");
  });

  it("adds mailto and per_page from options", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(RESP, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    await openalex({ defaultLimit: 8, email: "a@b.co" }).execute(
      { query: "x" },
      ctx,
    );
    const u = String(fetchMock.mock.calls[0][0]);
    expect(u).toContain("per_page=8");
    expect(u).toContain("mailto=a%40b.co");
  });
});
