import { describe, expect, it } from "vitest";
import { computeDigest, type DigestMeta } from "./trace-digest.js";
import type { Span, SpanKind } from "./trace.js";

function span(
  p: Partial<Span> & { id: string; kind: SpanKind; t0: number; t1: number },
): Span {
  return {
    site: p.site ?? p.kind,
    status: p.status ?? "ok",
    waitMs: p.waitMs ?? 0,
    durationMs: p.durationMs ?? p.t1 - p.t0,
    ...p,
  };
}

const META: DigestMeta = {
  runId: "run_x",
  wallMs: 0,
  costUSD: 0,
  freshTokens: 0,
  replayedUSD: 0,
  gateLimitModel: 8,
  gateLimitIo: 10,
};

describe("computeDigest", () => {
  it("rolls a phase up by interval union, not by summing overlaps", () => {
    const spans = [
      span({ id: "a", kind: "model", site: "research", t0: 0, t1: 100 }),
      span({ id: "b", kind: "model", site: "research", t0: 50, t1: 150 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 150 });
    // union of [0,100] and [50,150] is 150, not 200
    expect(digest.phaseBreakdown.research.wallMs).toBe(150);
    expect(digest.phaseBreakdown.research.spanCount).toBe(2);
  });

  it("walks the critical path into the work span that extends furthest", () => {
    const spans = [
      span({ id: "short", kind: "model", site: "research", t0: 0, t1: 50 }),
      span({ id: "long", kind: "model", site: "research", t0: 0, t1: 100 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 100 });
    expect(digest.criticalPath.map((s) => s.spanId)).toEqual(["long"]);
    expect(digest.criticalPathMs).toBe(100);
  });

  it("counts idle gaps on the timeline", () => {
    const spans = [
      span({ id: "a", kind: "io", site: "fetch", t0: 0, t1: 30 }),
      span({ id: "b", kind: "io", site: "fetch", t0: 80, t1: 120 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 120 });
    expect(digest.idleMs).toBe(50);
  });

  it("computes peak model concurrency by overlap sweep", () => {
    const spans = [
      span({ id: "a", kind: "model", t0: 0, t1: 100 }),
      span({ id: "b", kind: "model", t0: 10, t1: 90 }),
      span({ id: "c", kind: "model", t0: 20, t1: 80 }),
      span({ id: "d", kind: "model", t0: 200, t1: 300 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 300 });
    expect(digest.concurrency.peakModelInFlight).toBe(3);
    expect(digest.concurrency.gateLimitModel).toBe(8);
  });

  it("does not double-count adjacent (touching) intervals as overlap", () => {
    const spans = [
      span({ id: "a", kind: "model", t0: 0, t1: 100 }),
      span({ id: "b", kind: "model", t0: 100, t1: 200 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 200 });
    expect(digest.concurrency.peakModelInFlight).toBe(1);
  });

  it("splits wait vs compute and flags high-wait spans", () => {
    const spans = [
      span({
        id: "slow",
        kind: "model",
        site: "verify",
        t0: 0,
        t1: 3000,
        waitMs: 2500,
        computeMs: 500,
      }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 3000 });
    expect(digest.modelWaitMs).toBe(2500);
    expect(digest.modelComputeMs).toBe(500);
    expect(digest.waitVsCompute.ratio).toBe(5);
    expect(digest.anomalies.some((a) => a.kind === "high-wait")).toBe(true);
  });

  it("flags identical fresh model calls as redundant spend", () => {
    const spans = [
      span({
        id: "a",
        kind: "model",
        t0: 0,
        t1: 10,
        attrs: { callKey: "deadbeefcafef00d" },
      }),
      span({
        id: "b",
        kind: "model",
        t0: 20,
        t1: 30,
        attrs: { callKey: "deadbeefcafef00d" },
      }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 30 });
    expect(digest.anomalies.some((a) => a.kind === "redundant-call")).toBe(true);
  });

  it("rolls per-agent self-time and uses the agent span for cost", () => {
    const spans = [
      span({
        id: "agent",
        kind: "agent",
        site: "research",
        agentId: "agent_2",
        logicalAgentId: "agent_2",
        role: "research",
        t0: 0,
        t1: 200,
        costUSD: 0.42,
      }),
      span({
        id: "m1",
        kind: "model",
        site: "research",
        agentId: "agent_2",
        t0: 10,
        t1: 60,
        costUSD: 0.2,
        tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
      }),
      span({
        id: "m2",
        kind: "model",
        site: "research",
        agentId: "agent_2",
        t0: 50,
        t1: 110,
        costUSD: 0.22,
        tokens: { input: 80, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 200 });
    const agent = digest.byAgent.find((a) => a.agentId === "agent_2");
    expect(agent).toBeDefined();
    expect(agent?.costUSD).toBe(0.42); // from the agent span, not summed model spans
    expect(agent?.subtreeMs).toBe(200);
    expect(agent?.selfMs).toBe(100); // union of [10,60] and [50,110]
    expect(agent?.tokens).toBe(210);
  });

  it("ranks model spans by wait, latency, and cost", () => {
    const spans = [
      span({ id: "cheap-fast", kind: "model", t0: 0, t1: 10, costUSD: 0.01, computeMs: 10 }),
      span({ id: "pricey", kind: "model", t0: 0, t1: 20, costUSD: 9, computeMs: 20 }),
      span({ id: "waiter", kind: "model", t0: 0, t1: 5000, waitMs: 4000, computeMs: 1000 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 5000 });
    expect(digest.topByCost[0].spanId).toBe("pricey");
    expect(digest.topByWait[0].spanId).toBe("waiter");
    expect(digest.topByLatency[0].spanId).toBe("waiter");
  });

  it("maps known sites back to source files", () => {
    const spans = [
      span({ id: "s", kind: "model", site: "synthesize", t0: 0, t1: 10 }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 10 });
    expect(digest.attribution.synthesize).toBe(
      "src/synthesize.ts:synthesizeReport",
    );
  });

  it("excludes replayed spans' callKeys from redundancy", () => {
    const spans = [
      span({
        id: "a",
        kind: "model",
        t0: 0,
        t1: 10,
        status: "replayed",
        attrs: { callKey: "k", replayed: true },
      }),
      span({
        id: "b",
        kind: "model",
        t0: 20,
        t1: 30,
        status: "replayed",
        attrs: { callKey: "k", replayed: true },
      }),
    ];
    const digest = computeDigest(spans, [], { ...META, wallMs: 30 });
    expect(digest.anomalies.some((a) => a.kind === "redundant-call")).toBe(
      false,
    );
  });
});
