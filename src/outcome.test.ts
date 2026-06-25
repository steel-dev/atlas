// ABOUTME: Tests for src/outcome.ts — classifies a completed run for CLI exit code.
// ABOUTME: Drives examples/cli.ts to exit non-zero and print the note on a zero-source run.
import { describe, expect, it } from "vitest";
import {
  classifyRunOutcome,
  DEGENERATE_EXIT_CODE,
  FAILED_EXIT_CODE,
} from "./outcome.js";

describe("classifyRunOutcome", () => {
  it("flags a zero-source run as degenerate with a non-zero exit code", () => {
    const outcome = classifyRunOutcome({
      sources: [],
      note: "Research failed before any sources could be retrieved: Invalid JSON response",
    });
    expect(outcome.status).toBe("degenerate");
    expect(outcome.exitCode).toBe(DEGENERATE_EXIT_CODE);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.note).toMatch(/Invalid JSON response/i);
  });

  it("treats a run that gathered sources as ok with exit code 0", () => {
    const outcome = classifyRunOutcome({
      sources: [{}, {}, {}],
      note: "",
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.exitCode).toBe(0);
  });

  it("flags a failed report phase even when sources were gathered", () => {
    const outcome = classifyRunOutcome({
      sources: [{}, {}, {}],
      note: "Synthesis failed: endpoint down\n\nGathered note",
      failure: {
        phase: "synthesis",
        message: "Synthesis failed: endpoint down",
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(FAILED_EXIT_CODE);
    expect(outcome.note).toBe("Synthesis failed: endpoint down");
  });
});
