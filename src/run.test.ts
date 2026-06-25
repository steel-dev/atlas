import { describe, expect, it } from "vitest";
import {
  acceptsRepair,
  deriveStopReason,
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

describe("deriveStopReason", () => {
  const base: StopReasonInputs = {
    finished: false,
    budgetExhausted: false,
    tokensExhausted: false,
    timedOut: false,
  };

  it("falls back to completed when nothing bound the run", () => {
    expect(deriveStopReason(base)).toBe("completed");
  });

  it("maps each binding cap to its reason", () => {
    expect(deriveStopReason({ ...base, budgetExhausted: true })).toBe("budget");
    expect(deriveStopReason({ ...base, tokensExhausted: true })).toBe("tokens");
    expect(deriveStopReason({ ...base, timedOut: true })).toBe("timeout");
  });

  it("prefers an explicit finish over any cap", () => {
    expect(
      deriveStopReason({ ...base, finished: true, budgetExhausted: true }),
    ).toBe("finished");
  });

  it("ranks budget over tokens and timeout when several apply", () => {
    expect(
      deriveStopReason({
        ...base,
        budgetExhausted: true,
        tokensExhausted: true,
        timedOut: true,
      }),
    ).toBe("budget");
  });
});
