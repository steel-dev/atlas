import { afterEach, describe, expect, it, vi } from "vitest";
import { openalex } from "./openalex.js";

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
    const results = await openalex().search({ query: "widgets" });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://doi.org/10.1/abc");
    expect(results[0].title).toBe("On Widgets");
    expect(results[0].snippet).toContain("The widget works");
    const fallback = String(results[0].meta?.fallbackText);
    expect(fallback).toContain("The widget works");
    expect(fallback).toContain("Authors: Jane Smith");
    expect(fallback).toContain("Widget Journal (2021)");
    expect(fallback).toContain("Cited by 42");
  });

  it("adds mailto and per_page from options", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(RESP, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await openalex({ defaultLimit: 8, email: "a@b.co" }).search({ query: "x" });
    const u = String(fetchMock.mock.calls[0][0]);
    expect(u).toContain("per_page=8");
    expect(u).toContain("mailto=a%40b.co");
  });
});
