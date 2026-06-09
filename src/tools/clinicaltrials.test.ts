import { afterEach, describe, expect, it, vi } from "vitest";
import { clinicaltrials } from "./clinicaltrials.js";
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
  studies: [
    {
      protocolSection: {
        identificationModule: {
          nctId: "NCT01234567",
          briefTitle: "A Trial of Semaglutide in Obesity",
          officialTitle: "A Long Official Title",
        },
        statusModule: { overallStatus: "RECRUITING" },
        sponsorCollaboratorsModule: { leadSponsor: { name: "Novo Nordisk A/S" } },
        descriptionModule: { briefSummary: "This study evaluates semaglutide." },
        conditionsModule: { conditions: ["Obesity", "Overweight"] },
        designModule: {
          studyType: "INTERVENTIONAL",
          phases: ["PHASE3"],
          enrollmentInfo: { count: 1250 },
        },
        armsInterventionsModule: {
          interventions: [{ type: "DRUG", name: "Semaglutide" }],
        },
      },
    },
    {
      protocolSection: {
        identificationModule: {
          nctId: "NCT07654321",
          briefTitle: "Observational Wegovy Study",
        },
        statusModule: { overallStatus: "ENROLLING_BY_INVITATION" },
        descriptionModule: { briefSummary: "Real-world use." },
        conditionsModule: { conditions: ["Obesity"] },
        designModule: { studyType: "OBSERVATIONAL" },
      },
    },
  ],
};

function ok(body: unknown) {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("clinicaltrials", () => {
  it("turns studies into canonical NCT sources", async () => {
    vi.stubGlobal("fetch", ok(RESULT));
    const { ctx, sources } = makeCtx();
    const out = await clinicaltrials().execute({ query: "semaglutide" }, ctx);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://clinicaltrials.gov/study/NCT01234567");
    expect(sources[0].title).toBe("A Trial of Semaglutide in Obesity");
    expect(sources[0].content).toContain("Status: RECRUITING");
    expect(sources[0].content).toContain("INTERVENTIONAL · PHASE3");
    expect(sources[0].content).toContain("Conditions: Obesity, Overweight");
    expect(sources[0].content).toContain("Interventions: Semaglutide");
    expect(sources[0].content).toContain("Sponsor: Novo Nordisk A/S");
    expect(sources[0].content).toContain("Enrollment: 1250");
    expect(sources[0].content).toContain("This study evaluates semaglutide.");
    expect(out).toContain("found 2 result");
  });

  it("passes query.term, pageSize and status filter", async () => {
    const fetchMock = ok(RESULT);
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = makeCtx();
    await clinicaltrials({ defaultLimit: 7, status: ["recruiting"] }).execute(
      { query: "obesity" },
      ctx,
    );
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("query.term=obesity");
    expect(url).toContain("pageSize=7");
    expect(url).toContain("filter.overallStatus=RECRUITING");
  });

  it("reports no results when studies is empty", async () => {
    vi.stubGlobal("fetch", ok({ studies: [] }));
    const { ctx, sources } = makeCtx();
    const out = await clinicaltrials().execute({ query: "zzz" }, ctx);
    expect(sources).toHaveLength(0);
    expect(out).toContain("no results");
  });
});
