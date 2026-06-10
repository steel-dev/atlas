import { describe, expect, it } from "vitest";
import {
  createBudgetMeter,
  DEFAULT_PRICING,
  resolvePricing,
  usageCostUSD,
} from "./budget.js";

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
  });

  it("falls back to conservative pricing for unknown models", () => {
    const { pricing, known } = resolvePricing(
      "totally-unknown-model",
      DEFAULT_PRICING,
    );
    expect(known).toBe(false);
    expect(pricing.inputPerMTok).toBeGreaterThanOrEqual(5);
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
