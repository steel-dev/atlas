// ABOUTME: Classifies a completed research run so a CLI/script can pick an exit code.
// ABOUTME: A zero-source run is degenerate (usually a model/search failure) and exits non-zero.
// Structurally typed so callers (examples/cli.ts) can pass a full ResearchResult without a hard dependency.
import type { ResearchFailure } from "./result.js";

export const DEGENERATE_EXIT_CODE = 3;
export const FAILED_EXIT_CODE = 1;

export interface RunOutcome {
  status: "ok" | "degenerate" | "failed";
  exitCode: number;
  note: string;
}

export function classifyRunOutcome(result: {
  sources: readonly unknown[];
  note: string;
  failure?: ResearchFailure;
}): RunOutcome {
  if (result.failure) {
    return {
      status: "failed",
      exitCode: FAILED_EXIT_CODE,
      note: result.failure.message,
    };
  }
  if (result.sources.length === 0) {
    return {
      status: "degenerate",
      exitCode: DEGENERATE_EXIT_CODE,
      note: result.note,
    };
  }
  return { status: "ok", exitCode: 0, note: result.note };
}
