import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { candidateConflictPairs, conflictPass } from "./conflicts.js";
import { createBudgetMeter } from "./budget.js";
import { EFFORT_ENVELOPES } from "./config.js";
import { createLedger, type Ledger, type ResearchClaim } from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import type { RunCtx } from "./state.js";

const CAPS = {
  maxClaims: EFFORT_ENVELOPES.balanced.maxConflictClaims,
  maxPairs: EFFORT_ENVELOPES.balanced.maxConflictPairs,
};

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

describe("candidateConflictPairs", () => {
  it("pairs lexically similar claims", () => {
    const pairs = candidateConflictPairs(
      [
        fakeClaim("claim_1", "The Eiffel Tower is 330 meters tall", "https://a.example.com"),
        fakeClaim("claim_2", "The Eiffel Tower stands 330 meters high", "https://b.example.org"),
      ],
      CAPS,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.id).toBe("claim_1");
    expect(pairs[0].b.id).toBe("claim_2");
  });

  it("pairs number-mismatched claims about the same entity as contradiction candidates", () => {
    const pairs = candidateConflictPairs(
      [
        fakeClaim("claim_1", "The tower is 330 meters tall", "https://a.example.com"),
        fakeClaim("claim_2", "The tower is 320 meters tall", "https://b.example.org"),
      ],
      CAPS,
    );
    expect(pairs).toHaveLength(1);
  });

  it("skips dissimilar claims", () => {
    const pairs = candidateConflictPairs(
      [
        fakeClaim("claim_1", "The Eiffel Tower is 330 meters tall", "https://a.example.com"),
        fakeClaim("claim_2", "Paris hosted the 2024 Summer Olympics", "https://b.example.org"),
      ],
      CAPS,
    );
    expect(pairs).toHaveLength(0);
  });
});

describe("conflictPass", () => {
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

  function fakeRunCtx(
    ledger: Ledger,
    verdicts: Array<{ index: number; verdict: string }>,
    emit: (event: { type: string }) => void = () => {},
  ): { rctx: RunCtx; verified: string[] } {
    const verified: string[] = [];
    const rctx = {
      ledger,
      config: { envelope: EFFORT_ENVELOPES.balanced },
      bindModel: () => judgeModel(verdicts),
      signal: undefined,
      emit,
      verifyReserve: createBudgetMeter(1),
      stopReason: () => null,
      verify: async (args: { claimIds: string[] }) => {
        verified.push(...args.claimIds);
        return { verdicts: [], note: "" };
      },
    } as unknown as RunCtx;
    return { rctx, verified };
  }

  it("merges judged duplicates and records corroboration", async () => {
    const ledger = await seededLedger();
    const { rctx } = fakeRunCtx(ledger, [{ index: 0, verdict: "duplicate" }]);
    const outcome = await conflictPass(rctx, createBudgetMeter(1));
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
    const { rctx } = fakeRunCtx(ledger, [{ index: 0, verdict: "distinct" }]);
    const outcome = await conflictPass(rctx, createBudgetMeter(1));
    expect(outcome.merged).toBe(0);
    expect(outcome.contradicted).toBe(0);
    expect(ledger.representatives()).toHaveLength(2);
  });

  it("links judged contradictions and routes both sides to the panel", async () => {
    const ledger = await seededLedger();
    const { rctx, verified } = fakeRunCtx(ledger, [
      { index: 0, verdict: "contradicts" },
    ]);
    const outcome = await conflictPass(rctx, createBudgetMeter(1));
    expect(outcome.contradicted).toBe(1);
    expect(outcome.merged).toBe(0);
    const representatives = ledger.representatives();
    expect(representatives).toHaveLength(2);
    const [a, b] = representatives;
    expect(a.conflictsWith).toEqual([b.id]);
    expect(b.conflictsWith).toEqual([a.id]);
    expect(verified).toContain(a.id);
    expect(verified).toContain(b.id);
  });

  it("routes only the decisively weaker side of a contradiction to the panel", async () => {
    const ledger = await seededLedger();
    const [strong, weak] = ledger.representatives();
    strong.sourceQuality = "primary";
    strong.corroboration = 3;
    weak.sourceQuality = "forum";
    const { rctx, verified } = fakeRunCtx(ledger, [
      { index: 0, verdict: "contradicts" },
    ]);
    const outcome = await conflictPass(rctx, createBudgetMeter(1));
    expect(outcome.contradicted).toBe(1);
    expect(strong.conflictsWith).toEqual([weak.id]);
    expect(weak.conflictsWith).toEqual([strong.id]);
    expect(verified).toContain(weak.id);
    expect(verified).not.toContain(strong.id);
    expect(strong.status).toBe("quoted");
  });

  it("preserves an already-settled claim while routing its conflict", async () => {
    const ledger = await seededLedger();
    const confirmed = ledger.representatives()[0];
    confirmed.votes = [
      { lens: "quote-fidelity", refuted: false, evidence: "e", confidence: "high" },
      { lens: "source-strength", refuted: false, evidence: "e", confidence: "high" },
    ];
    confirmed.status = "confirmed";
    const { rctx } = fakeRunCtx(ledger, [{ index: 0, verdict: "contradicts" }]);
    const outcome = await conflictPass(rctx, createBudgetMeter(1));
    expect(outcome.contradicted).toBe(1);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.conflictsWith).toHaveLength(1);
    expect(ledger.representatives()[1].conflictsWith).toHaveLength(1);
  });
});

describe("candidateConflictPairs input cap", () => {
  it("considers central claims first when the claim set exceeds the cap", () => {
    const filler: ResearchClaim[] = Array.from({ length: 500 }, (_, i) => ({
      ...fakeClaim(`claim_f${i}`, `token${i}a token${i}b token${i}c token${i}d token${i}e`, `https://f${i}.example.com`),
      importance: "tangential" as const,
    }));
    const central = [
      fakeClaim("claim_a", "The bridge spans 1991 meters across the strait", "https://a.example.com"),
      fakeClaim("claim_b", "The bridge spans 1991 meters over the strait", "https://b.example.org"),
    ];
    const pairs = candidateConflictPairs([...filler, ...central], CAPS);
    expect(
      pairs.some(
        (pair) =>
          (pair.a.id === "claim_a" && pair.b.id === "claim_b") ||
          (pair.a.id === "claim_b" && pair.b.id === "claim_a"),
      ),
    ).toBe(true);
  });
});
