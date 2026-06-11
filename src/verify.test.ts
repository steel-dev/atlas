import { describe, expect, it } from "vitest";
import { runVerifySpawn, settleClaim, voteSplit } from "./verify.js";
import type { ClaimVote, ResearchClaim } from "./ledger.js";
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
});
