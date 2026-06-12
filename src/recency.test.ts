import { describe, expect, it } from "vitest";
import {
  NEUTRAL_RECENCY,
  isTimeSensitive,
  parsePublishedDate,
  recencyScore,
} from "./recency.js";

describe("recency", () => {
  const today = "2026-06-12";

  it("scores a fresh source at 1 and an old one at 0", () => {
    expect(recencyScore("2026-05-01", today)).toBe(1);
    expect(recencyScore("2015-01-01", today)).toBe(0);
  });

  it("decays monotonically between fresh and stale", () => {
    const oneYear = recencyScore("2025-06-12", today);
    const threeYears = recencyScore("2023-06-12", today);
    expect(oneYear).toBeGreaterThan(threeYears);
    expect(oneYear).toBeLessThan(1);
    expect(threeYears).toBeGreaterThan(0);
  });

  it("returns the neutral score for undateable input", () => {
    expect(recencyScore(undefined, today)).toBe(NEUTRAL_RECENCY);
    expect(recencyScore("sometime last spring", today)).toBe(NEUTRAL_RECENCY);
  });

  it("falls back to a bare year when the date does not parse", () => {
    expect(parsePublishedDate("published in 2024")).toBeTypeOf("number");
    expect(parsePublishedDate("no date here")).toBeUndefined();
  });

  it("never reads the wall clock — score depends only on todayISO", () => {
    expect(recencyScore("2020-01-01", "2020-06-01")).toBeGreaterThan(
      recencyScore("2020-01-01", "2026-06-01"),
    );
  });

  it("detects time-sensitive questions", () => {
    expect(isTimeSensitive("what is the latest model from Anthropic?")).toBe(
      true,
    );
    expect(isTimeSensitive("현재 가장 빠른 모델은?")).toBe(true);
    expect(isTimeSensitive("trends in browser automation for 2026")).toBe(true);
    expect(isTimeSensitive("how does photosynthesis work?")).toBe(false);
  });
});
