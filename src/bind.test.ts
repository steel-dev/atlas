import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { bindCitations, createMarkerStripper, stripMarkers } from "./bind.js";
import { EFFORT_ENVELOPES } from "./config.js";
import type { ResearchClaim } from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import type { RunCtx } from "./state.js";

describe("stripMarkers", () => {
  it("removes markers and records their positions", () => {
    const draft =
      "Paris is the capital of France. {{claim_1}} It has 2.1 million residents. {{claim_2,claim_3}}";
    const { report, markers } = stripMarkers(draft);
    expect(report).toBe(
      "Paris is the capital of France. It has 2.1 million residents.",
    );
    expect(markers).toHaveLength(2);
    expect(markers[0].claimIds).toEqual(["claim_1"]);
    expect(markers[1].claimIds).toEqual(["claim_2", "claim_3"]);
    expect(report.slice(0, markers[0].pos)).toBe(
      "Paris is the capital of France.",
    );
  });

  it("ignores malformed markers", () => {
    const { report, markers } = stripMarkers("Fact. {{not a marker}}");
    expect(markers).toHaveLength(0);
    expect(report).toBe("Fact.");
  });
});

function fakeCtx(claims: ResearchClaim[], sourceText: string): RunCtx {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const document = createSourceDocument(
    "https://example.com/page",
    "Example",
    sourceText,
    { markdownChars: sourceText.length, extractionNotes: [] },
    sourceText.length,
    "source_1",
  );
  const events: unknown[] = [];
  return {
    config: { envelope: { ...EFFORT_ENVELOPES.fast, maxEntailmentChecks: 0 } },
    ledger: { byId: (id: string) => byId.get(id) },
    sources: { byId: new Map([["source_1", document]]) },
    emit: (event: unknown) => events.push(event),
  } as unknown as RunCtx;
}

function makeClaim(id: string, quote: string): ResearchClaim {
  return {
    id,
    text: "Paris is the capital of France",
    quote,
    importance: "central",
    sourceQuality: "secondary",
    sourceId: "source_1",
    url: "https://example.com/page",
    title: "Example",
    status: "confirmed",
    votes: [],
    agentId: "agent_1",
  };
}

describe("bindCitations", () => {
  it("verifies citations whose quotes appear in the stored source", async () => {
    const claim = makeClaim("claim_1", "Paris is the capital of France");
    const rctx = fakeCtx(
      [claim],
      "As everyone knows, Paris is the capital of France since forever.",
    );
    const grant = {
      limitUSD: 1,
      spentUSD: () => 0,
      remainingUSD: () => 1,
      floored: () => false,
      charge: () => {},
      reserve: () => null,
      grant: () => null,
      release: () => {},
    };
    const outcome = await bindCitations(
      rctx,
      grant,
      "Paris is the capital of France. {{claim_1}}",
    );
    expect(outcome.citations).toHaveLength(1);
    expect(outcome.citations[0].verified).toBe(true);
    expect(outcome.citationsBound).toBe(1);
    expect(outcome.report).toBe("Paris is the capital of France.");
    const [start, end] = outcome.citations[0].sentenceSpan;
    expect(outcome.report.slice(start, end)).toBe(
      "Paris is the capital of France.",
    );
  });

  it("marks citations unverified when the quote is missing from the source", async () => {
    const claim = makeClaim("claim_1", "a quote that is not in the source");
    const rctx = fakeCtx([claim], "Totally different page content here.");
    const grant = {
      limitUSD: 1,
      spentUSD: () => 0,
      remainingUSD: () => 1,
      floored: () => false,
      charge: () => {},
      reserve: () => null,
      grant: () => null,
      release: () => {},
    };
    const outcome = await bindCitations(
      rctx,
      grant,
      "Paris is the capital of France. {{claim_1}}",
    );
    expect(outcome.citations[0].verified).toBe(false);
    expect(outcome.citationsUnsupported).toBeGreaterThanOrEqual(1);
  });

  it("marks citations of refuted claims unsupported even when the quote matches", async () => {
    const claim = makeClaim("claim_1", "Paris is the capital of France");
    claim.status = "refuted";
    const rctx = fakeCtx(
      [claim],
      "As everyone knows, Paris is the capital of France since forever.",
    );
    const grant = {
      limitUSD: 1,
      spentUSD: () => 0,
      remainingUSD: () => 1,
      floored: () => false,
      charge: () => {},
      reserve: () => null,
      grant: () => null,
      release: () => {},
    };
    const outcome = await bindCitations(
      rctx,
      grant,
      "Paris is the capital of France. {{claim_1}}",
    );
    expect(outcome.citations[0].verified).toBe(false);
    expect(outcome.citations[0].status).toBe("refuted");
    expect(outcome.citationsUnsupported).toBeGreaterThanOrEqual(1);
  });

  it("marks markers citing unknown claim ids unsupported instead of skipping them", async () => {
    const rctx = fakeCtx([], "Some page content.");
    const grant = {
      limitUSD: 1,
      spentUSD: () => 0,
      remainingUSD: () => 1,
      floored: () => false,
      charge: () => {},
      reserve: () => null,
      grant: () => null,
      release: () => {},
    };
    const outcome = await bindCitations(
      rctx,
      grant,
      "Paris is the capital of France. {{claim_404}}",
    );
    expect(outcome.citations).toHaveLength(1);
    expect(outcome.citations[0].claimId).toBe("claim_404");
    expect(outcome.citations[0].verified).toBe(false);
    expect(outcome.citations[0].status).toBeUndefined();
    expect(outcome.citationsUnsupported).toBeGreaterThanOrEqual(1);
  });

  it("does not break sentence spans on abbreviations, decimals, or acronyms", async () => {
    const claim = makeClaim("claim_1", "Paris is the capital of France");
    const rctx = fakeCtx(
      [claim],
      "As everyone knows, Paris is the capital of France since forever.",
    );
    const grant = {
      limitUSD: 1,
      spentUSD: () => 0,
      remainingUSD: () => 1,
      floored: () => false,
      charge: () => {},
      reserve: () => null,
      grant: () => null,
      release: () => {},
    };
    const outcome = await bindCitations(
      rctx,
      grant,
      "First sentence ends here. Dr. Smith measured a 3.14 ratio in the U.S. survey. {{claim_1}}",
    );
    const [start, end] = outcome.citations[0].sentenceSpan;
    expect(outcome.report.slice(start, end)).toBe(
      "Dr. Smith measured a 3.14 ratio in the U.S. survey.",
    );
  });
});

describe("createMarkerStripper", () => {
  it("strips a marker split across chunks", () => {
    const stripper = createMarkerStripper();
    const out =
      stripper.push("The tower is 330 meters tall.") +
      stripper.push(" {{cla") +
      stripper.push("im_1}} It was built in 1889.") +
      stripper.flush();
    expect(out).toBe("The tower is 330 meters tall. It was built in 1889.");
  });

  it("holds back a lone brace and releases it when it is not a marker", () => {
    const stripper = createMarkerStripper();
    expect(stripper.push("f(x) {")).toBe("f(x)");
    expect(stripper.push(" return 1; }")).toBe(" { return 1; }");
    expect(stripper.flush()).toBe("");
  });

  it("emits an unterminated marker tail on flush", () => {
    const stripper = createMarkerStripper();
    expect(stripper.push("Done. {{claim_9")).toBe("Done.");
    expect(stripper.flush()).toBe(" {{claim_9");
  });

  it("strips multi-id markers and keeps surrounding text intact", () => {
    const stripper = createMarkerStripper();
    const out =
      stripper.push("A fact. {{claim_2,claim_3}} Another fact.") +
      stripper.flush();
    expect(out).toBe("A fact. Another fact.");
  });
});

describe("bindCitations joint entailment", () => {
  const grant = {
    limitUSD: 1,
    spentUSD: () => 0,
    remainingUSD: () => 1,
    floored: () => false,
    charge: () => {},
    reserve: () => null,
    grant: () => null,
    release: () => {},
  };
  const source = "In 2024 revenue rose 10% while costs rose 30% at the firm.";
  const claims: ResearchClaim[] = [
    {
      ...makeClaim("claim_1", "revenue rose 10%"),
      text: "Revenue rose ten percent in 2024",
    },
    {
      ...makeClaim("claim_2", "costs rose 30%"),
      text: "Costs rose thirty percent in 2024",
    },
  ];

  function entailmentModel(supported: boolean, calls: string[]) {
    return new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(JSON.stringify(options.prompt));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ checks: [{ index: 0, supported }] }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 50, text: 50, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
  }

  function entailmentCtx(model: MockLanguageModelV3): RunCtx {
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    const document = createSourceDocument(
      "https://example.com/page",
      "Example",
      source,
      { markdownChars: source.length, extractionNotes: [] },
      source.length,
      "source_1",
    );
    return {
      config: {
        envelope: { ...EFFORT_ENVELOPES.balanced, maxEntailmentChecks: 10 },
      },
      ledger: { byId: (id: string) => byId.get(id) },
      sources: { byId: new Map([["source_1", document]]) },
      bindModel: () => model,
      emit: () => {},
    } as unknown as RunCtx;
  }

  it("checks a multi-claim sentence as one joint group and keeps both citations when the union entails it", async () => {
    const calls: string[] = [];
    const rctx = entailmentCtx(entailmentModel(true, calls));
    const outcome = await bindCitations(
      rctx,
      grant as never,
      "In 2024 revenue rose 10% while costs rose 30% at the firm. {{claim_1,claim_2}}",
    );
    expect(outcome.citations).toHaveLength(2);
    expect(outcome.citations.every((citation) => citation.verified)).toBe(true);
    expect(outcome.citationsBound).toBe(2);
    expect(outcome.citationsUnsupported).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Revenue rose ten percent in 2024");
    expect(calls[0]).toContain("Costs rose thirty percent in 2024");
  });

  it("flips every citation in the group when the union does not entail the sentence", async () => {
    const calls: string[] = [];
    const rctx = entailmentCtx(entailmentModel(false, calls));
    const outcome = await bindCitations(
      rctx,
      grant as never,
      "In 2024 revenue rose 10%, so the firm became profitable. {{claim_1,claim_2}}",
    );
    expect(outcome.citations).toHaveLength(2);
    expect(outcome.citations.every((citation) => !citation.verified)).toBe(true);
    expect(outcome.citationsBound).toBe(0);
    expect(outcome.citationsUnsupported).toBe(2);
    expect(calls).toHaveLength(1);
  });
});
