import { describe, expect, it } from "vitest";
import {
  acceptsRepair,
  deriveStopReason,
  draftHasCitationMarkers,
} from "./run.js";
import type { StopReasonInputs } from "./run.js";


describe("acceptsRepair", () => {
  it("accepts a repair that cuts unsupported citations without losing bound ones", () => {
    expect(
      acceptsRepair(
        { citationsUnsupported: 3, citationsBound: 5 },
        { citationsUnsupported: 1, citationsBound: 5 },
      ),
    ).toBe(true);
  });

  it("accepts a repair that cuts unsupported and gains bound citations", () => {
    expect(
      acceptsRepair(
        { citationsUnsupported: 2, citationsBound: 4 },
        { citationsUnsupported: 0, citationsBound: 5 },
      ),
    ).toBe(true);
  });

  it("rejects a repair that wins on the count by dropping verified content", () => {
    expect(
      acceptsRepair(
        { citationsUnsupported: 3, citationsBound: 6 },
        { citationsUnsupported: 0, citationsBound: 2 },
      ),
    ).toBe(false);
  });

  it("rejects a repair that does not reduce unsupported citations", () => {
    expect(
      acceptsRepair(
        { citationsUnsupported: 2, citationsBound: 5 },
        { citationsUnsupported: 2, citationsBound: 7 },
      ),
    ).toBe(false);
  });
});

describe("draftHasCitationMarkers", () => {
  it("accepts a draft that carries claim markers", () => {
    expect(
      draftHasCitationMarkers(
        "AWS HealthOmics is HIPAA-eligible. {{claim_3}} It stores petabytes. {{claim_7,claim_9}}",
      ),
    ).toBe(true);
  });

  it("rejects a truncated synthesis fragment with no markers", () => {
    expect(
      draftHasCitationMarkers(
        "I have enough to compute and write. Let me do a quick cost computation for the 100,000-genome scenario.",
      ),
    ).toBe(false);
  });

  it("rejects an empty draft", () => {
    expect(draftHasCitationMarkers("")).toBe(false);
  });
});

describe("deriveStopReason", () => {
  const base: StopReasonInputs = {
    stopped: false,
    budgetExhausted: false,
    tokensExhausted: false,
    timedOut: false,
    agentCapReached: false,
    answered: false,
  };

  it("falls back to completed when nothing bound the run", () => {
    expect(deriveStopReason(base)).toBe("completed");
  });

  it("reports answered when coverage judged the question answered", () => {
    expect(deriveStopReason({ ...base, answered: true })).toBe("answered");
  });

  it("maps each binding cap to its reason", () => {
    expect(deriveStopReason({ ...base, budgetExhausted: true })).toBe("budget");
    expect(deriveStopReason({ ...base, tokensExhausted: true })).toBe("tokens");
    expect(deriveStopReason({ ...base, timedOut: true })).toBe("timeout");
    expect(deriveStopReason({ ...base, agentCapReached: true })).toBe(
      "agent-cap",
    );
  });

  it("prefers an explicit stop over any cap", () => {
    expect(
      deriveStopReason({ ...base, stopped: true, budgetExhausted: true }),
    ).toBe("stopped");
  });

  it("prefers a binding cap over a positive answered signal", () => {
    expect(
      deriveStopReason({ ...base, budgetExhausted: true, answered: true }),
    ).toBe("budget");
  });

  it("ranks budget over tokens, timeout, and agent-cap when several apply", () => {
    expect(
      deriveStopReason({
        ...base,
        budgetExhausted: true,
        tokensExhausted: true,
        timedOut: true,
        agentCapReached: true,
      }),
    ).toBe("budget");
  });
});
