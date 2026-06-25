import { afterEach, describe, expect, it, vi } from "vitest";
import { pubmed } from "./pubmed.js";

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
  it("searches then returns canonical abstract results", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const results = await pubmed().search({ query: "things" });
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
    expect(results[0].title).toBe("A Study of Things");
    const fallback = String(results[0].meta?.fallbackText);
    expect(fallback).toContain("Authors: Jane Smith");
    expect(fallback).toContain("Journal of Tests (2020)");
    expect(fallback).toContain("BACKGROUND: We studied things.");
    expect(fallback).toContain("RESULTS: Things happened.");
  });

  it("passes tool/email/api_key and retmax", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    await pubmed({ defaultLimit: 9, apiKey: "KEY", email: "a@b.co" }).search({
      query: "x",
    });
    const esearchUrl = String(fetchMock.mock.calls[0][0]);
    expect(esearchUrl).toContain("retmax=9");
    expect(esearchUrl).toContain("tool=atlas");
    expect(esearchUrl).toContain("email=a%40b.co");
    expect(esearchUrl).toContain("api_key=KEY");
  });

  it("returns empty when idlist is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ esearchresult: { idlist: [] } }), {
            status: 200,
          }),
      ),
    );
    const results = await pubmed().search({ query: "nope" });
    expect(results).toHaveLength(0);
  });
});
