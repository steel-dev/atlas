import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runVerifySpawn, screenClaim, settleClaim, voteSplit } from "./verify.js";
import { createBudgetMeter } from "./budget.js";
import type { ClaimVote, ResearchClaim } from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import type { RunCtx } from "./state.js";

function claim(): ResearchClaim {
  return {
    id: "claim_1",
    text: "test claim",
    quote: "quote",
    importance: "central",
    sourceQuality: "secondary",
    sourceId: "source_1",
    url: "https://example.com",
    title: "Example",
    status: "quoted",
    votes: [],
    agentId: "agent_1",
  };
}

function vote(refuted: boolean): ClaimVote {
  return { lens: "contradiction", refuted, evidence: "e", confidence: "medium" };
}

function screenModel(verdict: {
  quote_supports_claim: boolean;
  source_is_evidence: boolean;
  confidence: string;
  note: string;
}): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(verdict) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

function screeningRctx(
  claims: ResearchClaim[],
  model: MockLanguageModelV3,
): RunCtx {
  const markdown =
    "According to the official register, the quote text appears here.".padEnd(
      250,
      " filler",
    );
  const document = createSourceDocument(
    "https://example.com",
    "Example",
    markdown,
    { markdownChars: markdown.length, extractionNotes: [] },
    markdown.length,
    "source_1",
  );
  return {
    question: "test question",
    ledger: {
      byId: (id: string) => claims.find((claim) => claim.id === id),
    },
    sources: { byId: new Map([["source_1", document]]) },
    verifyInFlight: new Map<string, Promise<void>>(),
    counters: { claimsVerified: 0 },
    emit: () => {},
    stopReason: () => null,
    bindModel: () => model,
    signal: undefined,
  } as unknown as RunCtx;
}

describe("screenClaim", () => {
  it("settles a clean screen as a single non-refuting screening vote", async () => {
    const c = claim();
    const rctx = screeningRctx([c], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "high",
      note: "context plainly supports the claim",
    }));
    const votes = await screenClaim(rctx, createBudgetMeter(1), c);
    expect(votes).toHaveLength(1);
    expect(votes![0].lens).toBe("screening");
    expect(votes![0].refuted).toBe(false);
  });

  it("escalates when the screen flags the quote", async () => {
    const c = claim();
    const rctx = screeningRctx([c], screenModel({
      quote_supports_claim: false,
      source_is_evidence: true,
      confidence: "high",
      note: "overreach",
    }));
    expect(await screenClaim(rctx, createBudgetMeter(1), c)).toBeNull();
  });

  it("escalates on low confidence", async () => {
    const c = claim();
    const rctx = screeningRctx([c], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "low",
      note: "thin context",
    }));
    expect(await screenClaim(rctx, createBudgetMeter(1), c)).toBeNull();
  });
});

describe("runVerifySpawn staged verification", () => {
  it("settles non-central claims from the screen without a panel", async () => {
    const supporting = claim();
    supporting.importance = "supporting";
    const rctx = screeningRctx([supporting], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "medium",
      note: "supported in context",
    }));
    const outcome = await runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant: createBudgetMeter(1),
      parentId: "agent_1",
      depth: 1,
    });
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).toBe("screened");
    expect(outcome.verdicts[0].votes).toBe("1-0");
    expect(supporting.votes).toHaveLength(1);
  });

  it("screens central claims when the grant cannot fund a panel", async () => {
    const central = claim();
    const rctx = screeningRctx([central], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "high",
      note: "context plainly supports the claim",
    }));
    const outcome = await runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant: createBudgetMeter(0.03),
      parentId: "agent_1",
      depth: 1,
    });
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).toBe("screened");
    expect(outcome.verdicts[0].votes).toBe("1-0");
    expect(central.votes).toHaveLength(1);
  });

  it("leaves starved conflicted claims contested without spending", async () => {
    const conflicted = claim();
    conflicted.conflictsWith = ["claim_2"];
    conflicted.status = "contested";
    const rctx = screeningRctx([conflicted], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "high",
      note: "unused",
    }));
    const outcome = await runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant: createBudgetMeter(0.03),
      parentId: "agent_1",
      depth: 1,
    });
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).toBe("contested");
    expect(conflicted.votes).toHaveLength(0);
    expect(
      (rctx as unknown as { counters: { claimsVerified: number } }).counters
        .claimsVerified,
    ).toBe(0);
  });

  it("does not downgrade a screened claim when the panel cannot be funded", async () => {
    const screened = claim();
    settleClaim(screened, [
      { lens: "screening", refuted: false, evidence: "e", confidence: "high" },
    ]);
    const rctx = screeningRctx([screened], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "high",
      note: "unused",
    }));
    const outcome = await runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant: createBudgetMeter(0.03),
      depth: 1,
    });
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).toBe("screened");
    expect(screened.votes).toHaveLength(1);
  });

  it("escalates conflicted claims to the panel instead of the screen", async () => {
    const conflicted = claim();
    conflicted.importance = "supporting";
    conflicted.conflictsWith = ["claim_2"];
    const rctx = screeningRctx([conflicted], screenModel({
      quote_supports_claim: true,
      source_is_evidence: true,
      confidence: "high",
      note: "would have settled from the screen",
    }));
    const outcome = await runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant: createBudgetMeter(1),
      parentId: "agent_1",
      depth: 1,
    });
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).not.toBe("confirmed");
    expect(conflicted.votes).toHaveLength(0);
  });
});

describe("runVerifySpawn dedup", () => {
  function rctxFor(claims: ResearchClaim[]): RunCtx {
    return {
      ledger: {
        byId: (id: string) => claims.find((claim) => claim.id === id),
      },
      verifyInFlight: new Map<string, Promise<void>>(),
      counters: { claimsVerified: 0 },
      emit: () => {},
      stopReason: () => null,
    } as unknown as RunCtx;
  }

  const grant = {
    limitUSD: 1,
    spentUSD: () => 0,
    remainingUSD: () => 1,
    floored: () => true,
    charge: () => {},
    grant: () => null,
    release: () => {},
  };

  it("returns the existing verdict for settled claims without re-voting", async () => {
    const settled = claim();
    settleClaim(settled, [vote(false), vote(false), vote(false)]);
    const rctx = rctxFor([settled]);
    const outcome = await runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant,
      parentId: "agent_1",
      depth: 1,
    });
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).toBe("confirmed");
    expect(outcome.verdicts[0].votes).toBe("3-0");
    expect(
      (rctx as unknown as { counters: { claimsVerified: number } }).counters
        .claimsVerified,
    ).toBe(0);
  });

  it("awaits an in-flight verification instead of starting another", async () => {
    const pending = claim();
    const rctx = rctxFor([pending]);
    let release!: () => void;
    const job = new Promise<void>((resolve) => {
      release = resolve;
    });
    rctx.verifyInFlight.set("claim_1", job);
    const outcomePromise = runVerifySpawn(rctx, {
      claimIds: ["claim_1"],
      grant,
      parentId: "agent_1",
      depth: 1,
    });
    settleClaim(pending, [vote(false), vote(false)]);
    release();
    const outcome = await outcomePromise;
    expect(outcome.verdicts).toHaveLength(1);
    expect(outcome.verdicts[0].status).toBe("confirmed");
    expect(
      (rctx as unknown as { counters: { claimsVerified: number } }).counters
        .claimsVerified,
    ).toBe(0);
  });
});

describe("settleClaim", () => {
  it("confirms with a quorum of non-refuting votes", () => {
    const c = claim();
    settleClaim(c, [vote(false), vote(false), vote(false)]);
    expect(c.status).toBe("confirmed");
    expect(voteSplit(c)).toBe("3-0");
  });

  it("marks contested on a single refutation", () => {
    const c = claim();
    settleClaim(c, [vote(false), vote(true), vote(false)]);
    expect(c.status).toBe("contested");
    expect(voteSplit(c)).toBe("2-1");
  });

  it("refutes on a refutation quorum", () => {
    const c = claim();
    settleClaim(c, [vote(true), vote(true), vote(false)]);
    expect(c.status).toBe("refuted");
  });

  it("leaves claims unverified with too few votes (all-abstain never passes)", () => {
    const c = claim();
    settleClaim(c, [vote(false)]);
    expect(c.status).toBe("unverified");
    const c2 = claim();
    settleClaim(c2, []);
    expect(c2.status).toBe("unverified");
  });

  it("keeps conflicted claims contested when votes are insufficient", () => {
    const c = claim();
    c.conflictsWith = ["claim_9"];
    settleClaim(c, [vote(false)]);
    expect(c.status).toBe("contested");
  });

  it("marks a clean screening vote as screened, never confirmed", () => {
    const c = claim();
    settleClaim(c, [
      { lens: "screening", refuted: false, evidence: "e", confidence: "high" },
    ]);
    expect(c.status).toBe("screened");
    expect(voteSplit(c)).toBe("1-0");
  });
});
