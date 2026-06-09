import { afterEach, describe, expect, it, vi } from "vitest";
import { edgar } from "./edgar.js";
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
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("edgar", () => {
  it("lists filings with canonical Archives URLs without claiming them as sources", async () => {
    vi.stubGlobal("fetch", ok(RESULT));
    const { ctx, sources } = makeCtx();
    const out = await edgar({ email: "t@e.co" }).execute(
      { query: "climate risk" },
      ctx,
    );
    expect(sources).toHaveLength(0);
    expect(out).toContain("found 2 filing");
    expect(out).toContain(
      "https://www.sec.gov/Archives/edgar/data/35527/000003552722000119/fitbannualreport202110-k.pdf",
    );
    expect(out).toContain(
      "https://www.sec.gov/Archives/edgar/data/815097/000081509723000012/ccl-20221130.htm",
    );
    expect(out).toContain("FIFTH THIRD BANCORP");
    expect(out).toContain("10-K");
    expect(out).toContain("period 2021-12-31");
  });

  it("applies form filter, date range and limit to the request", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    const out = await edgar({
      forms: ["10-K", "10-Q"],
      from: "2022-01-01",
      to: "2022-12-31",
      defaultLimit: 1,
      email: "t@e.co",
    }).execute({ query: "x" }, ctx);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("forms=10-K%2C10-Q");
    expect(url).toContain("startdt=2022-01-01");
    expect(url).toContain("enddt=2022-12-31");
    expect(out).toContain("found 1 filing");
    expect(out).toContain("FIFTH THIRD BANCORP");
    expect(out).not.toContain("CARNIVAL");
  });

  it("sends a contact user-agent built from email", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    await edgar({ email: "me@x.co" }).execute({ query: "x" }, ctx);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(String(headers["user-agent"])).toContain("me@x.co");
  });

  it("refuses to call SEC without a contact email", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    const out = await edgar().execute({ query: "x" }, ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toContain("contact email");
  });

  it("reports no results on empty hits", async () => {
    vi.stubGlobal("fetch", ok({ hits: { hits: [] } }));
    const { ctx } = makeCtx();
    const out = await edgar({ email: "t@e.co" }).execute({ query: "zzz" }, ctx);
    expect(out).toContain("no results");
  });
});
