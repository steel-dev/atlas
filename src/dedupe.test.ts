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

  it("skips pairs whose numbers disagree", () => {
    const pairs = candidateDuplicatePairs([
      fakeClaim("claim_1", "The tower is 330 meters tall", "https://a.example.com"),
      fakeClaim("claim_2", "The tower is 320 meters tall", "https://b.example.org"),
    ]);
    expect(pairs).toHaveLength(0);
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

  function judgeModel(verdicts: Array<{ index: number; duplicate: boolean }>) {
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
      bindModel: () => judgeModel([{ index: 0, duplicate: true }]),
      signal: undefined,
      emit: () => {},
    } as unknown as RunCtx;
    const merged = await semanticDedupePass(rctx, createBudgetMeter(1));
    expect(merged).toBe(1);
    const representatives = ledger.representatives();
    expect(representatives).toHaveLength(1);
    expect(representatives[0].corroboration).toBe(2);
    expect(representatives[0].corroboratingSources).toContain(
      "https://b.example.org/2",
    );
  });

  it("leaves non-duplicates untouched", async () => {
    const ledger = await seededLedger();
    const rctx = {
      ledger,
      bindModel: () => judgeModel([{ index: 0, duplicate: false }]),
      signal: undefined,
      emit: () => {},
    } as unknown as RunCtx;
    const merged = await semanticDedupePass(rctx, createBudgetMeter(1));
    expect(merged).toBe(0);
    expect(ledger.representatives()).toHaveLength(2);
  });
});
