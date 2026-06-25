import { afterEach, describe, expect, it, vi } from "vitest";
import { edgar } from "./edgar.js";

const RESULT = {
  hits: {
    total: { value: 2 },
    hits: [
      {
        _id: "0000035527-22-000119:fitbannualreport202110-k.pdf",
        _source: {
          ciks: ["0000035527"],
          display_names: ["FIFTH THIRD BANCORP  (FITB)  (CIK 0000035527)"],
          form: "10-K",
          file_date: "2022-02-25",
          period_ending: "2021-12-31",
          adsh: "0000035527-22-000119",
          biz_locations: ["Cincinnati, OH"],
        },
      },
      {
        _id: "0000815097-23-000012:ccl-20221130.htm",
        _source: {
          ciks: ["0000815097"],
          display_names: ["CARNIVAL CORP  (CCL)  (CIK 0000815097)"],
          form: "10-K",
          file_date: "2023-01-27",
          period_ending: "2022-11-30",
          adsh: "0000815097-23-000012",
          biz_locations: ["Miami, FL"],
        },
      },
    ],
  },
};

function ok(body: unknown) {
  return vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("edgar", () => {
  it("lists filings as results with canonical Archives URLs", async () => {
    vi.stubGlobal("fetch", ok(RESULT));
    const results = await edgar({ email: "t@e.co" }).search({
      query: "climate risk",
    });
    expect(results).toHaveLength(2);
    const urls = results.map((r) => r.url);
    expect(urls).toContain(
      "https://www.sec.gov/Archives/edgar/data/35527/000003552722000119/fitbannualreport202110-k.pdf",
    );
    expect(urls).toContain(
      "https://www.sec.gov/Archives/edgar/data/815097/000081509723000012/ccl-20221130.htm",
    );
    expect(results[0].title).toContain("FIFTH THIRD BANCORP");
    expect(results[0].title).toContain("10-K");
    expect(results[0].title).toContain("period 2021-12-31");
  });

  it("applies form filter, date range and limit to the request", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    const results = await edgar({
      forms: ["10-K", "10-Q"],
      from: "2022-01-01",
      to: "2022-12-31",
      defaultLimit: 1,
      email: "t@e.co",
    }).search({ query: "x" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("forms=10-K%2C10-Q");
    expect(url).toContain("startdt=2022-01-01");
    expect(url).toContain("enddt=2022-12-31");
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("FIFTH THIRD BANCORP");
    expect(results[0].title).not.toContain("CARNIVAL");
  });

  it("sends a contact user-agent built from email", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    await edgar({ email: "me@x.co" }).search({ query: "x" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(String(headers["user-agent"])).toContain("me@x.co");
  });

  it("throws without a contact email", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    await expect(edgar().search({ query: "x" })).rejects.toThrow(/contact email/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty on empty hits", async () => {
    vi.stubGlobal("fetch", ok({ hits: { hits: [] } }));
    const results = await edgar({ email: "t@e.co" }).search({ query: "zzz" });
    expect(results).toHaveLength(0);
  });
});
