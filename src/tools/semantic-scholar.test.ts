import { afterEach, describe, expect, it, vi } from "vitest";
import { semanticScholar } from "./semantic-scholar.js";
import type { ToolContext } from "../custom-tools.js";

function makeCtx(signal?: AbortSignal) {
  const sources: { url: string; title?: string; content: string }[] = [];
  const ctx: ToolContext = {
    addSource: (s) => sources.push(s),
    signal,
    log: () => {},
  };
  return { ctx, sources };
}

const RESULT = {
  total: 2,
  data: [
    {
      paperId: "abc123",
      title: "Attention Is All You Need",
      abstract: "We propose the Transformer.",
      authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
      year: 2017,
      venue: "NeurIPS",
      citationCount: 100000,
      tldr: { text: "A new architecture based solely on attention." },
      externalIds: { DOI: "10.5555/3295222.3295349" },
      url: "https://www.semanticscholar.org/paper/abc123",
    },
    {
      paperId: "def456",
      title: "A Paper Without DOI",
      abstract: null,
      authors: [],
      year: 2020,
      venue: "",
      citationCount: 3,
      tldr: null,
      externalIds: {},
      url: "https://www.semanticscholar.org/paper/def456",
    },
  ],
};

function respond(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("semanticScholar", () => {
  it("turns papers into sources, preferring DOI URLs and including TL;DR", async () => {
    vi.stubGlobal("fetch", respond(200, RESULT));
    const { ctx, sources } = makeCtx();
    const out = await semanticScholar().execute({ query: "transformer" }, ctx);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://doi.org/10.5555/3295222.3295349");
    expect(sources[0].title).toBe("Attention Is All You Need");
    expect(sources[0].content).toContain("Authors: Ashish Vaswani, Noam Shazeer");
    expect(sources[0].content).toContain("NeurIPS (2017)");
    expect(sources[0].content).toContain("Cited by 100000");
    expect(sources[0].content).toContain(
      "TL;DR: A new architecture based solely on attention.",
    );
    expect(sources[1].url).toBe("https://www.semanticscholar.org/paper/def456");
    expect(out).toContain("found 2 result");
  });

  it("sends query, limit, fields and api key header", async () => {
    const fetchMock = respond(200, RESULT);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    await semanticScholar({ defaultLimit: 8, apiKey: "KEY" }).execute(
      { query: "graph" },
      ctx,
    );
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("query=graph");
    expect(url).toContain("limit=8");
    expect(url).toContain("fields=");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("KEY");
  });

  it("returns a friendly message on rate limit", async () => {
    vi.stubGlobal("fetch", respond(429, { message: "Too Many Requests" }));
    const { ctx, sources } = makeCtx();
    const out = await semanticScholar().execute({ query: "x" }, ctx);
    expect(sources).toHaveLength(0);
    expect(out).toContain("rate limited");
    expect(out).toContain("ATLAS_S2_API_KEY");
  });

  it("reports no results when data is empty", async () => {
    vi.stubGlobal("fetch", respond(200, { total: 0, data: [] }));
    const { ctx, sources } = makeCtx();
    const out = await semanticScholar().execute({ query: "zzz" }, ctx);
    expect(sources).toHaveLength(0);
    expect(out).toContain("no results");
  });
});
