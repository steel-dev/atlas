import { describe, expect, it } from "vitest";
import { fallbackReportFromClaims } from "./synthesize.js";
import type { ClaimStatus, ResearchClaim } from "./claims.js";

function claim(id: string, status: ClaimStatus, refuted = 0): ResearchClaim {
  return {
    id,
    text: `claim ${id}`,
    quote: `quote ${id}`,
    importance: "central",
    sourceQuality: "secondary",
    sourceId: `s-${id}`,
    url: `https://example.com/${id}`,
    title: `Source ${id}`,
    status,
    votes: [
      { lens: "quote-fidelity", refuted: refuted > 0, evidence: "", confidence: "low" },
      { lens: "source-strength", refuted: false, evidence: "", confidence: "low" },
    ],
  };
}

describe("fallbackReportFromClaims", () => {
  it("includes unrefuted candidates, not just confirmed claims", () => {
    const md = fallbackReportFromClaims({
      question: "Q",
      confirmed: [claim("c1", "confirmed")],
      candidates: [claim("u1", "unverified"), claim("u2", "unverified")],
    });
    // Both confirmed and candidate material must survive a synthesis failure —
    // this is the regression that produced 1-claim reports.
    expect(md).toContain("claim c1");
    expect(md).toContain("claim u1");
    expect(md).toContain("claim u2");
    expect(md).toContain("Unrefuted but unverified (2)");
  });

  it("renders a candidate-only run (zero confirmed) instead of going empty", () => {
    const md = fallbackReportFromClaims({
      question: "Q",
      confirmed: [],
      candidates: [claim("u1", "unverified")],
      gapsNote: "Missing Zimbabwe figures.",
    });
    expect(md).toContain("claim u1");
    expect(md).toContain("## Gap assessment");
    expect(md).toContain("Missing Zimbabwe figures.");
    expect(md).not.toContain("Verified findings (0)");
  });

  it("never throws and always carries the question", () => {
    const md = fallbackReportFromClaims({
      question: "Land reform outcomes?",
      confirmed: [],
      candidates: [],
    });
    expect(md).toContain("Land reform outcomes?");
  });
});
