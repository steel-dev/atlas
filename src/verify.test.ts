import { describe, expect, it } from "vitest";
import { settleClaim, voteSplit } from "./verify.js";
import type { ClaimVote, ResearchClaim } from "./ledger.js";

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
