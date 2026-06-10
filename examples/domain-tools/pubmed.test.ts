import { afterEach, describe, expect, it, vi } from "vitest";
import { pubmed } from "./pubmed.js";
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

const EFETCH = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>111</PMID>
      <Article>
        <Journal>
          <Title>Journal of Tests</Title>
          <JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue>
        </Journal>
        <ArticleTitle>A Study of Things</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND">We studied things.</AbstractText>
          <AbstractText Label="RESULTS">Things happened.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author><LastName>Smith</LastName><ForeName>Jane</ForeName></Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>222</PMID>
      <Article>
        <ArticleTitle>Second Study</ArticleTitle>
        <Abstract><AbstractText>Plain abstract.</AbstractText></Abstract>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("esearch"))
      return new Response(
        JSON.stringify({ esearchresult: { idlist: ["111", "222"] } }),
        { status: 200 },
      );
    return new Response(EFETCH, { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("pubmed", () => {
  it("searches then fetches abstracts into canonical sources", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { ctx, sources } = makeCtx();
    const out = await pubmed().execute({ query: "things" }, ctx);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
    expect(sources[0].title).toBe("A Study of Things");
    expect(sources[0].content).toContain("Authors: Jane Smith");
    expect(sources[0].content).toContain("Journal of Tests (2020)");
    expect(sources[0].content).toContain("BACKGROUND: We studied things.");
    expect(sources[0].content).toContain("RESULTS: Things happened.");
    expect(out).toContain("found 2 result");
  });

  it("passes tool/email/api_key and retmax", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    await pubmed({ defaultLimit: 9, apiKey: "KEY", email: "a@b.co" }).execute(
      { query: "x" },
      ctx,
    );
    const esearchUrl = String(fetchMock.mock.calls[0][0]);
    expect(esearchUrl).toContain("retmax=9");
    expect(esearchUrl).toContain("tool=atlas");
    expect(esearchUrl).toContain("email=a%40b.co");
    expect(esearchUrl).toContain("api_key=KEY");
  });

  it("reports no results when idlist is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ esearchresult: { idlist: [] } }), {
            status: 200,
          }),
      ),
    );
    const { ctx, sources } = makeCtx();
    const out = await pubmed().execute({ query: "nope" }, ctx);
    expect(sources).toHaveLength(0);
    expect(out).toContain("no results");
  });
});
