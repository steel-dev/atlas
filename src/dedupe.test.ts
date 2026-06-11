import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { candidateDuplicatePairs, semanticDedupePass } from "./dedupe.js";
import { createBudgetMeter } from "./budget.js";
import { createLedger, type Ledger, type ResearchClaim } from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import type { RunCtx } from "./state.js";

function fakeClaim(id: string, text: string, url: string): ResearchClaim {
  return {
    id,
    text,
    quote: text,
    importance: "central",
    sourceQuality: "secondary",
    sourceId: `source_${id}`,
    url,
    title: "Test",
    status: "quoted",
    votes: [],
    agentId: "agent_1",
  };
}

describe("candidateDuplicatePairs", () => {
  it("pairs lexically similar claims", () => {
    const pairs = candidateDuplicatePairs([
      fakeClaim("claim_1", "The Eiffel Tower is 330 meters tall", "https://a.example.com"),
      fakeClaim("claim_2", "The Eiffel Tower stands 330 meters high", "https://b.example.org"),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe("claim_1");
    expect(pairs[0].b.id).toBe("claim_2");
  });

  it("pairs number-mismatched claims about the same entity as contradiction candidates", () => {
    const pairs = candidateDuplicatePairs([
      fakeClaim("claim_1", "The tower is 330 meters tall", "https://a.example.com"),
      fakeClaim("claim_2", "The tower is 320 meters tall", "https://b.example.org"),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it("skips dissimilar claims", () => {
    const pairs = candidateDuplicatePairs([
      fakeClaim("claim_1", "The Eiffel Tower is 330 meters tall", "https://a.example.com"),
      fakeClaim("claim_2", "Paris hosted the 2024 Summer Olympics", "https://b.example.org"),
    ]);
    expect(pairs).toHaveLength(0);
  });
});

describe("semanticDedupePass", () => {
  function extractionModel(
    claims: Array<{ claim: string; quote: string; importance: string }>,
  ) {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ sourceQuality: "secondary", claims }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
        warnings: [],
      }),
    });
  }

  function judgeModel(verdicts: Array<{ index: number; verdict: string }>) {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
        warnings: [],
      }),
    });
  }

  async function seededLedger(): Promise<Ledger> {
    const ledger = createLedger({
      emit: () => {},
      signal: undefined,
      shouldExtract: () => true,
    });
    const seed = async (
      sourceId: string,
      url: string,
      text: string,
    ): Promise<void> => {
      const padded = text.padEnd(250, " filler text to clear the minimum");
      ledger.queue(
        createSourceDocument(
          url,
          "Test page",
          padded,
          { markdownChars: padded.length, extractionNotes: [] },
          padded.length,
          sourceId,
        ),
        {
          goal: "g",
          agentId: "agent_1",
          model: extractionModel([
            { claim: text, quote: text, importance: "central" },
          ]) as never,
        },
      );
      await ledger.settle();
    };
    await seed(
      "source_1",
      "https://a.example.com/1",
      "The Eiffel Tower is 330 meters tall",
    );
    await seed(
      "source_2",
      "https://b.example.org/2",
      "The Eiffel Tower stands 330 meters high",
    );
    return ledger;
  }

  it("merges judged duplicates and records corroboration", async () => {
    const ledger = await seededLedger();
    const rctx = {
      ledger,
      bindModel: () => judgeModel([{ index: 0, verdict: "duplicate" }]),
      signal: undefined,
      emit: () => {},
    } as unknown as RunCtx;
    const outcome = await semanticDedupePass(rctx, createBudgetMeter(1));
    expect(outcome.merged).toBe(1);
    const representatives = ledger.representatives();
    expect(representatives).toHaveLength(1);
    expect(representatives[0].corroboration).toBe(2);
    expect(representatives[0].corroboratingSources).toContain(
      "https://b.example.org/2",
    );
  });

  it("leaves distinct pairs untouched", async () => {
    const ledger = await seededLedger();
    const rctx = {
      ledger,
      bindModel: () => judgeModel([{ index: 0, verdict: "distinct" }]),
      signal: undefined,
      emit: () => {},
    } as unknown as RunCtx;
    const outcome = await semanticDedupePass(rctx, createBudgetMeter(1));
    expect(outcome.merged).toBe(0);
    expect(outcome.contradicted).toBe(0);
    expect(ledger.representatives()).toHaveLength(2);
  });

  it("marks judged contradictions contested and links both claims", async () => {
    const ledger = await seededLedger();
    const events: Array<{ type: string }> = [];
    const rctx = {
      ledger,
      bindModel: () => judgeModel([{ index: 0, verdict: "contradicts" }]),
      signal: undefined,
      emit: (event: { type: string }) => events.push(event),
    } as unknown as RunCtx;
    const outcome = await semanticDedupePass(rctx, createBudgetMeter(1));
    expect(outcome.contradicted).toBe(1);
    expect(outcome.merged).toBe(0);
    const representatives = ledger.representatives();
    expect(representatives).toHaveLength(2);
    const [a, b] = representatives;
    expect(a.status).toBe("contested");
    expect(b.status).toBe("contested");
    expect(a.conflictsWith).toEqual([b.id]);
    expect(b.conflictsWith).toEqual([a.id]);
    expect(
      events.filter((event) => event.type === "claim.verified"),
    ).toHaveLength(2);
  });

  it("does not downgrade already-voted claims when marking conflicts", async () => {
    const ledger = await seededLedger();
    const confirmed = ledger.representatives()[0];
    confirmed.votes = [
      { lens: "quote-fidelity", refuted: false, evidence: "e", confidence: "high" },
      { lens: "source-strength", refuted: false, evidence: "e", confidence: "high" },
    ];
    confirmed.status = "confirmed";
    const rctx = {
      ledger,
      bindModel: () => judgeModel([{ index: 0, verdict: "contradicts" }]),
      signal: undefined,
      emit: () => {},
    } as unknown as RunCtx;
    const outcome = await semanticDedupePass(rctx, createBudgetMeter(1));
    expect(outcome.contradicted).toBe(1);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.conflictsWith).toHaveLength(1);
    expect(ledger.representatives()[1].status).toBe("contested");
  });
});

describe("candidateDuplicatePairs input cap", () => {
  it("considers central claims first when the claim set exceeds the cap", () => {
    const filler: ResearchClaim[] = Array.from({ length: 500 }, (_, i) => ({
      ...fakeClaim(`claim_f${i}`, `token${i}a token${i}b token${i}c token${i}d token${i}e`, `https://f${i}.example.com`),
      importance: "tangential" as const,
    }));
    const central = [
      fakeClaim("claim_a", "The bridge spans 1991 meters across the strait", "https://a.example.com"),
      fakeClaim("claim_b", "The bridge spans 1991 meters over the strait", "https://b.example.org"),
    ];
    const pairs = candidateDuplicatePairs([...filler, ...central]);
    expect(
      pairs.some(
        (pair) =>
          (pair.a.id === "claim_a" && pair.b.id === "claim_b") ||
          (pair.a.id === "claim_b" && pair.b.id === "claim_a"),
      ),
    ).toBe(true);
  });
});
