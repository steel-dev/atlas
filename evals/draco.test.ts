import { describe, expect, it } from "vitest";
import {
  buildEvalOptions,
  type CriterionReport,
  type DracoCase,
  type EvalOptions,
  scoreReports,
  selectCases,
} from "./draco.js";

function crit(
  weight: number,
  verdict: "MET" | "UNMET",
  sectionId = "factual-accuracy",
): CriterionReport {
  return {
    sectionId,
    id: `${sectionId}-${weight}-${verdict}`,
    requirement: "requirement",
    weight,
    verdict,
    reason: "",
  };
}

describe("scoreReports", () => {
  it("all positive MET -> 100% / pass 100%", () => {
    const s = scoreReports([crit(10, "MET"), crit(5, "MET")]);
    expect(s.rawScore).toBe(15);
    expect(s.normalizedScore).toBe(1);
    expect(s.passRate).toBe(1);
  });

  it("mixed positives + negative: raw / positive weight, pass fraction", () => {
    const s = scoreReports([
      crit(10, "MET"),
      crit(10, "UNMET"),
      crit(-5, "UNMET"),
    ]);
    expect(s.positiveWeight).toBe(20);
    expect(s.rawScore).toBe(10);
    expect(s.normalizedScore).toBeCloseTo(0.5, 10);
    expect(s.passRate).toBeCloseTo(2 / 3, 10);
  });

  it("negative MET penalizes and clamps at 0", () => {
    const s = scoreReports([crit(10, "MET"), crit(-20, "MET")]);
    expect(s.rawScore).toBe(-10);
    expect(s.normalizedScore).toBe(0);
  });

  it("all-negative rubric, no errors present (all UNMET) -> 100%", () => {
    const s = scoreReports([crit(-10, "UNMET"), crit(-5, "UNMET")]);
    expect(s.positiveWeight).toBe(0);
    expect(s.normalizedScore).toBe(1);
    expect(s.passRate).toBe(1);
  });

  it("all-negative rubric, all errors present (all MET) -> 0%", () => {
    const s = scoreReports([crit(-10, "MET"), crit(-5, "MET")]);
    expect(s.normalizedScore).toBe(0);
    expect(s.passRate).toBe(0);
  });

  it("empty rubric -> 0", () => {
    const s = scoreReports([]);
    expect(s.normalizedScore).toBe(0);
    expect(s.passRate).toBe(0);
  });
});

function mkCase(id: string, domain: string): DracoCase {
  return {
    id,
    domain,
    problem: "p",
    rubricId: id,
    sections: [{ id: "factual-accuracy", title: "Factual Accuracy" }],
    criteria: [
      {
        sectionId: "factual-accuracy",
        sectionTitle: "Factual Accuracy",
        id: "x",
        weight: 1,
        requirement: "r",
      },
    ],
    raw: {},
  };
}

const DOMAINS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const CASES: DracoCase[] = DOMAINS.flatMap((d) =>
  [0, 1, 2].map((i) => mkCase(`${d}-${i}`, d)),
);

function opts(overrides: Partial<EvalOptions>): EvalOptions {
  return buildEvalOptions({
    casesPath: "x",
    seed: "seed-1",
    gradeRuns: 1,
    judgeTimeoutMs: 1,
    judgeConcurrency: 1,
    retries: 0,
    ...overrides,
  });
}

describe("selectCases", () => {
  it("stratified sample of 10 -> 1 per domain across all 10 domains", () => {
    const picked = selectCases(CASES, opts({ sample: 10 }));
    expect(picked.length).toBe(10);
    expect(new Set(picked.map((p) => p.domain)).size).toBe(10);
  });

  it("stratified sample of 20 -> 2 per domain", () => {
    const picked = selectCases(CASES, opts({ sample: 20 }));
    const counts = new Map<string, number>();
    for (const p of picked) {
      counts.set(p.domain, (counts.get(p.domain) ?? 0) + 1);
    }
    expect(picked.length).toBe(20);
    expect([...counts.values()].every((c) => c === 2)).toBe(true);
  });

  it("is deterministic for a fixed seed", () => {
    const a = selectCases(CASES, opts({ sample: 10 })).map((p) => p.id);
    const b = selectCases(CASES, opts({ sample: 10 })).map((p) => p.id);
    expect(a).toEqual(b);
  });

  it("stratify=none returns a seeded global sample", () => {
    const picked = selectCases(CASES, opts({ sample: 5, stratify: "none" }));
    expect(picked.length).toBe(5);
  });

  it("returns all cases when sample exceeds total", () => {
    const picked = selectCases(CASES, opts({ sample: 999 }));
    expect(picked.length).toBe(CASES.length);
  });
});
