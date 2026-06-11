import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import type { BindOutcome } from "./bind.js";
import { createBudgetMeter } from "./budget.js";
import type { ResearchEvent } from "./events.js";
import type { ResearchClaim } from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import {
  repairReport,
  stripReportPreamble,
  synthesizeReport,
} from "./synthesize.js";
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
    config: { envelope: { maxReportTokens: 8_192 } },
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

describe("synthesizeReport with tools", () => {
  it("lets the writer consult sources before producing the report", async () => {
    const report = "The tower is 330 meters tall. {{claim_1}}";
    let step = 0;
    const writer = new MockLanguageModelV3({
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
        step++;
        if (step === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "search_sources",
                input: JSON.stringify({ query: "tower height" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: USAGE,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: report }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });
    const streamingWriter = wrapLanguageModel({
      model: writer,
      middleware: simulateStreamingMiddleware(),
    });
    const markdown =
      "The official register lists the tower at 330 meters tall.".padEnd(
        250,
        " filler",
      );
    const document = createSourceDocument(
      "https://example.com",
      "Register",
      markdown,
      { markdownChars: markdown.length, extractionNotes: [] },
      markdown.length,
      "source_1",
    );
    const events: ResearchEvent[] = [];
    const rctx = {
      question: "how tall is the tower?",
      bindModel: () => streamingWriter,
      config: { envelope: { maxReportTokens: 8_192 } },
      sources: {
        byId: new Map([["source_1", document]]),
        byUrl: new Map([["https://example.com", document]]),
      },
      emit: (event: ResearchEvent) => events.push(event),
      signal: undefined,
    } as unknown as RunCtx;
    const result = await synthesizeReport(rctx, createBudgetMeter(1), {
      partition: {
        confirmed: [fakeClaim("claim_1")],
        screened: [],
        contested: [],
        refuted: [],
        candidates: [],
      },
    });
    expect(result).toBe(report);
    expect(step).toBe(2);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("report.drafting");
    expect(types.slice(1).every((type) => type === "report.delta")).toBe(true);
    expect(types.filter((type) => type === "report.delta").length).toBeGreaterThan(0);
    const streamed = events
      .filter(
        (event): event is Extract<ResearchEvent, { type: "report.delta" }> =>
          event.type === "report.delta",
      )
      .map((event) => event.text)
      .join("");
    expect(streamed).toBe("The tower is 330 meters tall.");
  });
});

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

describe("stripReportPreamble", () => {
  it("drops a narration line before a horizontal rule", () => {
    const report =
      "I have what I need. Writing the report.\n\n---\n\nLand reform across these states shows X [](https://example.com). {{claim_1}}";
    expect(stripReportPreamble(report)).toBe(
      "Land reform across these states shows X [](https://example.com). {{claim_1}}",
    );
  });

  it("drops a bare leading horizontal rule", () => {
    const report = "\n---\n# Findings\n\nBody. {{claim_1}}";
    expect(stripReportPreamble(report)).toBe("# Findings\n\nBody. {{claim_1}}");
  });

  it("drops a narration paragraph before a heading", () => {
    const report = "Writing the report now.\n\n# Findings\n\nBody. {{claim_1}}";
    expect(stripReportPreamble(report)).toBe("# Findings\n\nBody. {{claim_1}}");
  });

  it("keeps an opening paragraph that carries citations", () => {
    const report =
      "The tower is [330 meters tall](https://example.com). {{claim_1}}\n\n---\n\nMore detail. {{claim_2}}";
    expect(stripReportPreamble(report)).toBe(report);
  });

  it("keeps a report that starts with a heading", () => {
    const report = "# Findings\n\n---\n\nBody. {{claim_1}}";
    expect(stripReportPreamble(report)).toBe(report);
  });

  it("keeps a short answer with no rules or headings", () => {
    const report = "The tower is 330 meters tall. {{claim_1}}";
    expect(stripReportPreamble(report)).toBe(report);
  });
});

describe("capPartitionForReport", () => {
  function statusClaim(
    id: string,
    status: ResearchClaim["status"],
    importance: ResearchClaim["importance"],
  ): ResearchClaim {
    return { ...fakeClaim(id), status, importance, text: `claim ${id}` };
  }

  it("returns the partition unchanged when under the cap", async () => {
    const { capPartitionForReport } = await import("./synthesize.js");
    const partition = {
      confirmed: [statusClaim("claim_1", "confirmed", "central")],
      screened: [],
      contested: [],
      refuted: [],
      candidates: [],
    };
    const capped = capPartitionForReport(partition, 50);
    expect(capped.partition).toBe(partition);
    expect(capped.omitted).toBe(0);
  });

  it("caps by importance with a contested floor and counts omissions", async () => {
    const { capPartitionForReport } = await import("./synthesize.js");
    const confirmed = [
      ...Array.from({ length: 10 }, (_, i) =>
        statusClaim(`claim_c${i}`, "confirmed", "central"),
      ),
      ...Array.from({ length: 90 }, (_, i) =>
        statusClaim(`claim_s${i}`, "confirmed", "supporting"),
      ),
    ];
    const screened = Array.from({ length: 30 }, (_, i) =>
      statusClaim(`claim_sc${i}`, "screened", "supporting"),
    );
    const contested = Array.from({ length: 20 }, (_, i) =>
      statusClaim(`claim_ct${i}`, "contested", "supporting"),
    );
    const capped = capPartitionForReport(
      { confirmed, screened, contested, refuted: [], candidates: [] },
      50,
    );
    const rendered =
      capped.partition.confirmed.length +
      capped.partition.screened.length +
      capped.partition.contested.length;
    expect(rendered).toBe(50);
    expect(capped.partition.contested.length).toBe(12);
    expect(capped.partition.confirmed.length).toBe(38);
    expect(capped.omitted).toBe(100);
    expect(
      capped.partition.confirmed.filter(
        (claim) => claim.importance === "central",
      ),
    ).toHaveLength(10);
  });
});
