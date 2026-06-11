import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { BindOutcome } from "./bind.js";
import { createBudgetMeter } from "./budget.js";
import type { ResearchClaim } from "./ledger.js";
import { repairReport } from "./synthesize.js";
import type { RunCtx } from "./state.js";

const USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function repairModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

function fakeClaim(id: string): ResearchClaim {
  return {
    id,
    text: "The tower is 330 meters tall",
    quote: "330 meters tall",
    importance: "central",
    sourceQuality: "primary",
    sourceId: "source_1",
    url: "https://example.com",
    title: "Example",
    status: "confirmed",
    votes: [],
    agentId: "agent_1",
  };
}

function fakeRctx(model: MockLanguageModelV3): RunCtx {
  return {
    question: "how tall is the tower?",
    bindModel: () => model,
    ledger: {
      byId: (id: string) => (id === "claim_1" ? fakeClaim("claim_1") : undefined),
      digest: () => "[claim_1·central·primary] The tower is 330 meters tall",
    },
    signal: undefined,
  } as unknown as RunCtx;
}

function boundWith(opts: {
  report: string;
  unverified?: Array<{ claimId: string; span: [number, number] }>;
  unsupportedSentences?: string[];
}): BindOutcome {
  const citations = (opts.unverified ?? []).map((item) => ({
    sentenceSpan: item.span,
    claimId: item.claimId,
    sourceId: "source_1",
    quote: "330 meters tall",
    verified: false,
  }));
  return {
    report: opts.report,
    citations,
    citationsBound: 0,
    citationsUnsupported:
      citations.length + (opts.unsupportedSentences?.length ?? 0),
    unsupportedSentences: opts.unsupportedSentences ?? [],
  };
}

describe("repairReport", () => {
  it("rewrites the draft when a citation fails entailment", async () => {
    const corrected = "The tower is 330 meters tall. {{claim_1}}";
    const rctx = fakeRctx(repairModel(corrected));
    const report = "The tower is 999 meters tall and made of gold.";
    const repaired = await repairReport(rctx, createBudgetMeter(1), {
      draft: "The tower is 999 meters tall and made of gold. {{claim_1}}",
      bound: boundWith({
        report,
        unverified: [{ claimId: "claim_1", span: [0, report.length] }],
      }),
    });
    expect(repaired).toBe(corrected);
  });

  it("repairs uncited factual sentences", async () => {
    const corrected = "Only the supported part remains. {{claim_1}}";
    const rctx = fakeRctx(repairModel(corrected));
    const repaired = await repairReport(rctx, createBudgetMeter(1), {
      draft: "Only the supported part remains. {{claim_1}} The moon is cheese.",
      bound: boundWith({
        report: "Only the supported part remains. The moon is cheese.",
        unsupportedSentences: ["The moon is cheese."],
      }),
    });
    expect(repaired).toBe(corrected);
  });

  it("returns undefined when there is nothing to repair", async () => {
    const rctx = fakeRctx(repairModel("unused"));
    const repaired = await repairReport(rctx, createBudgetMeter(1), {
      draft: "All good. {{claim_1}}",
      bound: boundWith({ report: "All good." }),
    });
    expect(repaired).toBeUndefined();
  });

  it("returns undefined when the grant is floored", async () => {
    const rctx = fakeRctx(repairModel("unused"));
    const meter = createBudgetMeter(1);
    meter.charge(0.999);
    const report = "Bad sentence.";
    const repaired = await repairReport(rctx, meter, {
      draft: "Bad sentence. {{claim_1}}",
      bound: boundWith({
        report,
        unverified: [{ claimId: "claim_1", span: [0, report.length] }],
      }),
    });
    expect(repaired).toBeUndefined();
  });
});
