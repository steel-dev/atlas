import { describe, expect, it } from "vitest";
import {
  createBudgetMeter,
  DEFAULT_PRICING,
  resolveBudgetPlan,
  resolvePricing,
  usageCostUSD,
} from "./budget.js";

const CHEAP = { inputPerMTok: 0.25, outputPerMTok: 2 };
const OPUS = { inputPerMTok: 5, outputPerMTok: 25 };
const FREE = { inputPerMTok: 0, outputPerMTok: 0 };

const planFor = (
  over: Partial<Parameters<typeof resolveBudgetPlan>[0]>,
) =>
  resolveBudgetPlan({
    budgetUSD: 0.5,
    maxTokens: 5_000_000,
    maxReportTokens: 4096,
    scope: "broad",
    researchPricing: CHEAP,
    ...over,
  });

describe("resolveBudgetPlan", () => {
  it("funds gather as the dominant share for a cheap model at low budget", () => {
    const plan = planFor({ researchPricing: CHEAP });
    expect(plan.feasible).toBe(true);
    expect(plan.gatherCeilingTokens).toBeGreaterThan(plan.draftReserveTokens);
  });

  it("rejects an expensive model on a tiny budget with an actionable reason", () => {
    const plan = planFor({ researchPricing: OPUS });
    expect(plan.feasible).toBe(false);
    expect(plan.reason).toMatch(/budget\.maxUSD/);
    expect(plan.reason).toMatch(/cheaper/);
  });

  it("is governed by maxTokens (not USD) for a free model", () => {
    const plan = planFor({ researchPricing: FREE });
    expect(plan.feasible).toBe(true);
    expect(plan.effectiveTokens).toBe(5_000_000);
    expect(Number.isFinite(plan.gatherCeilingTokens)).toBe(true);
  });

  it("admits a tighter budget for single_fact than broad on the same model", () => {
    const broad = planFor({ researchPricing: OPUS, scope: "broad" });
    const single = planFor({ researchPricing: OPUS, scope: "single_fact" });
    expect(single.draftReserveTokens).toBeLessThan(broad.draftReserveTokens);
    expect(broad.feasible).toBe(false);
    expect(single.feasible).toBe(true);
  });

  it("caps effective tokens by maxTokens when the USD budget is generous", () => {
    const plan = planFor({ budgetUSD: 1000, maxTokens: 200_000 });
    expect(plan.effectiveTokens).toBe(200_000);
  });

  it("never returns a negative or non-finite gather ceiling", () => {
    const plan = planFor({
      budgetUSD: 0.0001,
      maxTokens: 1000,
      researchPricing: OPUS,
    });
    expect(plan.gatherCeilingTokens).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(plan.gatherCeilingTokens)).toBe(true);
    expect(plan.feasible).toBe(false);
  });
});

describe("budget meter", () => {
  it("charges spend against the total", () => {
    const meter = createBudgetMeter(10);
    meter.charge(2.5);
    expect(meter.totalSpentUSD()).toBeCloseTo(2.5);
    expect(meter.remainingUSD()).toBeCloseTo(7.5);
    expect(meter.floored()).toBe(false);
  });

  it("reserves grants from the pool and returns unspent on release", () => {
    const meter = createBudgetMeter(10);
    const grant = meter.grant({ maxUSD: 4 });
    expect(grant).not.toBeNull();
    expect(meter.remainingUSD()).toBeCloseTo(6);
    grant!.charge(1);
    expect(meter.totalSpentUSD()).toBeCloseTo(1);
    grant!.release();
    expect(meter.remainingUSD()).toBeCloseTo(9);
    expect(meter.totalSpentUSD()).toBeCloseTo(1);
  });

  it("refuses grants when the pool is exhausted", () => {
    const meter = createBudgetMeter(0.05);
    const first = meter.grant({ maxUSD: 0.04 });
    expect(first).not.toBeNull();
    const second = meter.grant({ maxUSD: 0.04 });
    expect(second).toBeNull();
  });

  it("nests grants and propagates spend to the shared total", () => {
    const meter = createBudgetMeter(10);
    const parent = meter.grant({ maxUSD: 5 })!;
    const child = parent.grant({ maxUSD: 2 })!;
    child.charge(1.5);
    expect(meter.totalSpentUSD()).toBeCloseTo(1.5);
    expect(parent.remainingUSD()).toBeCloseTo(3);
    child.release();
    expect(parent.remainingUSD()).toBeCloseTo(3.5);
    expect(parent.spentUSD()).toBeCloseTo(1.5);
  });

  it("floors when remaining drops below the spawn floor", () => {
    const meter = createBudgetMeter(1);
    meter.charge(0.99);
    expect(meter.floored()).toBe(true);
  });

  it("holds reserved amounts until settled", () => {
    const meter = createBudgetMeter(1);
    const hold = meter.reserve(0.4);
    expect(hold).not.toBeNull();
    expect(meter.remainingUSD()).toBeCloseTo(0.6);
    expect(meter.totalSpentUSD()).toBe(0);
    hold!.settle(0.25);
    expect(meter.remainingUSD()).toBeCloseTo(0.75);
    expect(meter.totalSpentUSD()).toBeCloseTo(0.25);
  });

  it("releases holds without charging and ignores late settles", () => {
    const meter = createBudgetMeter(1);
    const hold = meter.reserve(0.4)!;
    hold.release();
    expect(meter.remainingUSD()).toBeCloseTo(1);
    hold.settle(0.4);
    expect(meter.totalSpentUSD()).toBe(0);
  });

  it("clamps reservations to remaining and refuses when exhausted", () => {
    const meter = createBudgetMeter(0.1);
    const hold = meter.reserve(5)!;
    expect(meter.remainingUSD()).toBe(0);
    expect(meter.reserve(0.01)).toBeNull();
    hold.settle(0.08);
    expect(meter.remainingUSD()).toBeCloseTo(0.02);
  });

  it("trips floored() while a reservation is outstanding", () => {
    const meter = createBudgetMeter(0.1);
    const hold = meter.reserve(0.09)!;
    expect(meter.floored()).toBe(true);
    hold.release();
    expect(meter.floored()).toBe(false);
  });
});

describe("pricing resolution", () => {
  it("resolves exact ids", () => {
    const { pricing, known } = resolvePricing(
      "claude-fable-5",
      DEFAULT_PRICING,
    );
    expect(known).toBe(true);
    expect(pricing.inputPerMTok).toBe(10);
    expect(pricing.outputPerMTok).toBe(50);
  });

  it("strips date suffixes and provider prefixes", () => {
    expect(
      resolvePricing("claude-haiku-4-5-20251001", DEFAULT_PRICING).known,
    ).toBe(true);
    expect(
      resolvePricing("us.anthropic.claude-opus-4-8", DEFAULT_PRICING).known,
    ).toBe(true);
    expect(resolvePricing("zai.GLM-5.2", DEFAULT_PRICING).known).toBe(true);
    expect(resolvePricing("zai.glm-5.2", DEFAULT_PRICING).known).toBe(true);
  });

  it("resolves dated small-model variants to the specific cheap entry, not the pricier prefix", () => {
    const nano = resolvePricing("gpt-5-nano-2025-08-07", DEFAULT_PRICING);
    expect(nano.known).toBe(true);
    expect(nano.pricing.inputPerMTok).toBe(0.05);
    expect(nano.pricing.outputPerMTok).toBe(0.4);

    const mini = resolvePricing("gpt-4o-mini-2024-07-18", DEFAULT_PRICING);
    expect(mini.known).toBe(true);
    expect(mini.pricing.inputPerMTok).toBe(0.15);

    const air = resolvePricing("GLM-4.5-Air-250414", DEFAULT_PRICING);
    expect(air.known).toBe(true);
    expect(air.pricing.inputPerMTok).toBe(0.2);
  });

  it("resolves Z.ai GLM pricing including cached input rates", () => {
    const { pricing, known } = resolvePricing("GLM-5.2", DEFAULT_PRICING);
    expect(known).toBe(true);
    expect(pricing.inputPerMTok).toBe(1.4);
    expect(pricing.cacheReadPerMTok).toBe(0.26);
    expect(pricing.cacheWritePerMTok).toBe(0);
    expect(pricing.outputPerMTok).toBe(4.4);

    const cost = usageCostUSD(
      {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      },
      pricing,
    );
    expect(cost).toBeCloseTo(6.06);
  });

  it("treats free Z.ai Flash models as zero-cost", () => {
    const { pricing, known } = resolvePricing("GLM-4.5-Flash", DEFAULT_PRICING);
    expect(known).toBe(true);
    expect(
      usageCostUSD(
        {
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 1_000_000,
          cacheWrite: 1_000_000,
        },
        pricing,
      ),
    ).toBe(0);
  });

  it("falls back to neutral mid-tier pricing for unknown models", () => {
    const { pricing, known } = resolvePricing(
      "totally-unknown-model",
      DEFAULT_PRICING,
    );
    expect(known).toBe(false);
    expect(pricing.inputPerMTok).toBe(3);
    expect(pricing.outputPerMTok).toBe(15);
  });

  it("computes usage cost with cache factors", () => {
    const cost = usageCostUSD(
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { inputPerMTok: 5, outputPerMTok: 25 },
    );
    expect(cost).toBeCloseTo(5);
    const cached = usageCostUSD(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      { inputPerMTok: 5, outputPerMTok: 25 },
    );
    expect(cached).toBeCloseTo(0.5);
  });
});
