import {
  SITE_SOURCE,
  TRACE_SCHEMA_VERSION,
  type CriticalSpan,
  type DigestAgent,
  type DigestAnomaly,
  type DigestPhase,
  type RunDigest,
  type Span,
  type TraceStep,
} from "./trace.js";

const TOP_N = 8;
const HIGH_WAIT_FLOOR_MS = 750;
const SLOW_STEP_FLOOR_MS = 4_000;
const MAX_CRITICAL_STEPS = 20_000;

export interface DigestMeta {
  runId: string;
  wallMs: number;
  costUSD: number;
  freshTokens: number;
  replayedUSD: number;
  gateLimitModel: number;
  gateLimitIo: number;
}

function tokensOf(span: Span): number {
  const t = span.tokens;
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0;
}

function toCritical(span: Span): CriticalSpan {
  return {
    spanId: span.id,
    site: span.site,
    ...(span.agentId ? { agentId: span.agentId } : {}),
    kind: span.kind,
    durationMs: span.durationMs,
    waitMs: span.waitMs,
  };
}

/** Klee's algorithm: total wall time covered by a set of [t0,t1] intervals. */
function intervalUnionMs(spans: readonly Span[]): number {
  const intervals = spans
    .map((s) => [s.t0, s.t1] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  if (intervals.length === 0) return 0;
  let total = 0;
  let [curStart, curEnd] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

/** Max number of overlapping intervals (sweep). Ties: ends before starts. */
function peakOverlap(spans: readonly Span[]): number {
  const points: Array<[number, number]> = [];
  for (const s of spans) {
    if (s.t1 <= s.t0) continue;
    points.push([s.t0, 1], [s.t1, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, delta] of points) {
    cur += delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/**
 * Greedy timeline cover: walk from run start, always stepping into the work
 * span that extends furthest from the cursor. Produces the chain of spans that
 * actually fills the wall clock — i.e. where the time went.
 */
function criticalPath(
  work: Span[],
  runStart: number,
  runEnd: number,
): { path: CriticalSpan[]; coveredMs: number; idleMs: number } {
  const sorted = [...work].sort((a, b) => a.t0 - b.t0);
  const path: CriticalSpan[] = [];
  let cursor = runStart;
  let covered = 0;
  let idle = 0;
  let guard = 0;
  while (cursor < runEnd && guard++ < MAX_CRITICAL_STEPS) {
    let pick: Span | undefined;
    let next: Span | undefined;
    for (const s of sorted) {
      if (s.t1 <= cursor) continue;
      if (s.t0 <= cursor) {
        if (!pick || s.t1 > pick.t1) pick = s;
      } else if (!next || s.t0 < next.t0) {
        next = s;
      }
    }
    if (pick) {
      path.push(toCritical(pick));
      covered += pick.t1 - cursor;
      cursor = pick.t1;
    } else if (next) {
      idle += next.t0 - cursor;
      cursor = next.t0;
    } else {
      break;
    }
  }
  return { path, coveredMs: covered, idleMs: idle };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function detectAnomalies(
  modelSpans: Span[],
  agentSpans: Span[],
): DigestAnomaly[] {
  const anomalies: DigestAnomaly[] = [];
  const waits = modelSpans.map((s) => s.waitMs);
  const computes = modelSpans
    .map((s) => s.computeMs ?? s.durationMs)
    .filter((v) => v > 0);
  const waitThreshold = Math.max(HIGH_WAIT_FLOOR_MS, percentile(waits, 95));
  const slowThreshold = Math.max(SLOW_STEP_FLOOR_MS, 3 * median(computes));

  for (const s of modelSpans) {
    if (s.waitMs >= waitThreshold && s.waitMs >= HIGH_WAIT_FLOOR_MS) {
      anomalies.push({
        kind: "high-wait",
        spanId: s.id,
        site: s.site,
        ...(s.agentId ? { agentId: s.agentId } : {}),
        detail: `queued ${Math.round(s.waitMs)}ms before the model gate freed a slot`,
        severityMs: Math.round(s.waitMs),
      });
    }
    const compute = s.computeMs ?? s.durationMs;
    if (compute >= slowThreshold) {
      anomalies.push({
        kind: "slow-step",
        spanId: s.id,
        site: s.site,
        ...(s.agentId ? { agentId: s.agentId } : {}),
        detail: `model call took ${Math.round(compute)}ms`,
        severityMs: Math.round(compute),
      });
    }
    if (s.retryDelayMs && s.retryDelayMs > 1_000) {
      anomalies.push({
        kind: "retry-storm",
        spanId: s.id,
        site: s.site,
        detail: `${Math.round(s.retryDelayMs)}ms lost to retries/backoff`,
        severityMs: Math.round(s.retryDelayMs),
      });
    }
    if (s.status === "error") {
      anomalies.push({
        kind: "error-step",
        spanId: s.id,
        site: s.site,
        ...(s.agentId ? { agentId: s.agentId } : {}),
        detail: `model call failed: ${String(s.attrs?.["finishReason"] ?? "error")}`,
      });
    }
  }

  const freshKeys = new Map<string, number>();
  for (const s of modelSpans) {
    if (s.status !== "ok") continue;
    const key = s.attrs?.["callKey"];
    if (typeof key !== "string" || !key) continue;
    freshKeys.set(key, (freshKeys.get(key) ?? 0) + 1);
  }
  for (const [key, count] of freshKeys) {
    if (count > 1) {
      anomalies.push({
        kind: "redundant-call",
        detail: `identical model call issued ${count}× (callKey ${key.slice(0, 8)}) — duplicated spend`,
      });
    }
  }

  const subtrees = agentSpans.map((s) => s.durationMs);
  const tailThreshold = 3 * median(subtrees);
  for (const s of agentSpans) {
    if (subtrees.length > 2 && s.durationMs >= tailThreshold && s.durationMs > 0) {
      anomalies.push({
        kind: "tail-agent",
        spanId: s.id,
        ...(s.agentId ? { agentId: s.agentId } : {}),
        detail: `agent ran ${Math.round(s.durationMs)}ms — a long pole vs sibling median`,
        severityMs: Math.round(s.durationMs),
      });
    }
  }

  return anomalies.sort((a, b) => (b.severityMs ?? 0) - (a.severityMs ?? 0));
}

export function computeDigest(
  spans: readonly Span[],
  _steps: readonly TraceStep[],
  meta: DigestMeta,
): RunDigest {
  const modelSpans = spans.filter((s) => s.kind === "model");
  const ioSpans = spans.filter((s) => s.kind === "io");
  const toolSpans = spans.filter((s) => s.kind === "tool");
  const agentSpans = spans.filter((s) => s.kind === "agent");
  const workSpans = [...modelSpans, ...ioSpans, ...toolSpans];

  const realStart = spans.reduce((min, s) => Math.min(min, s.t0), Infinity);
  const realEnd = spans.reduce((max, s) => Math.max(max, s.t1), 0);
  const runStart = Number.isFinite(realStart) ? realStart : 0;
  const runEnd = Math.max(realEnd, runStart);

  const modelComputeMs = modelSpans.reduce(
    (sum, s) => sum + (s.computeMs ?? s.durationMs),
    0,
  );
  const modelWaitMs = modelSpans.reduce((sum, s) => sum + s.waitMs, 0);
  const ioMs = intervalUnionMs(ioSpans);

  const { path, coveredMs, idleMs } = criticalPath(workSpans, runStart, runEnd);

  // phase rollups keyed by site (agents excluded — they wrap their children)
  const bySite = new Map<string, Span[]>();
  for (const s of workSpans) {
    const arr = bySite.get(s.site) ?? [];
    arr.push(s);
    bySite.set(s.site, arr);
  }
  const phaseBreakdown: Record<string, DigestPhase> = {};
  const attribution: Record<string, string> = {};
  for (const [site, arr] of bySite) {
    const models = arr.filter((s) => s.kind === "model");
    phaseBreakdown[site] = {
      wallMs: Math.round(intervalUnionMs(arr)),
      modelComputeMs: Math.round(
        models.reduce((sum, s) => sum + (s.computeMs ?? s.durationMs), 0),
      ),
      modelWaitMs: Math.round(models.reduce((sum, s) => sum + s.waitMs, 0)),
      costUSD:
        Math.round(arr.reduce((sum, s) => sum + (s.costUSD ?? 0), 0) * 10_000) /
        10_000,
      tokens: arr.reduce((sum, s) => sum + tokensOf(s), 0),
      spanCount: arr.length,
    };
    if (SITE_SOURCE[site]) attribution[site] = SITE_SOURCE[site];
  }

  // per-agent rollups
  const ownByAgent = new Map<string, Span[]>();
  for (const s of workSpans) {
    if (!s.agentId) continue;
    const arr = ownByAgent.get(s.agentId) ?? [];
    arr.push(s);
    ownByAgent.set(s.agentId, arr);
  }
  const agentSpanById = new Map<string, Span>();
  for (const s of agentSpans) if (s.agentId) agentSpanById.set(s.agentId, s);
  const byAgent: DigestAgent[] = [];
  for (const [agentId, own] of ownByAgent) {
    const wrapper = agentSpanById.get(agentId);
    byAgent.push({
      agentId,
      ...(wrapper?.logicalAgentId
        ? { logicalAgentId: wrapper.logicalAgentId }
        : {}),
      ...(wrapper?.role ? { role: wrapper.role } : {}),
      selfMs: Math.round(intervalUnionMs(own)),
      subtreeMs: Math.round(wrapper ? wrapper.durationMs : intervalUnionMs(own)),
      costUSD:
        Math.round(
          (wrapper?.costUSD ??
            own.reduce((sum, s) => sum + (s.costUSD ?? 0), 0)) * 10_000,
        ) / 10_000,
      tokens: own.reduce((sum, s) => sum + tokensOf(s), 0),
      spanCount: own.length,
    });
  }
  byAgent.sort((a, b) => b.subtreeMs - a.subtreeMs);

  const topByCost = [...modelSpans]
    .sort((a, b) => (b.costUSD ?? 0) - (a.costUSD ?? 0))
    .slice(0, TOP_N)
    .map(toCritical);
  const topByLatency = [...modelSpans]
    .sort(
      (a, b) => (b.computeMs ?? b.durationMs) - (a.computeMs ?? a.durationMs),
    )
    .slice(0, TOP_N)
    .map(toCritical);
  const topByWait = [...modelSpans]
    .sort((a, b) => b.waitMs - a.waitMs)
    .slice(0, TOP_N)
    .map(toCritical);

  return {
    runId: meta.runId,
    schemaVersion: TRACE_SCHEMA_VERSION,
    wallMs: Math.round(meta.wallMs),
    modelComputeMs: Math.round(modelComputeMs),
    modelWaitMs: Math.round(modelWaitMs),
    ioMs: Math.round(ioMs),
    costUSD: meta.costUSD,
    freshTokens: meta.freshTokens,
    replayedUSD: Math.round(meta.replayedUSD * 10_000) / 10_000,
    criticalPath: path,
    criticalPathMs: Math.round(coveredMs),
    idleMs: Math.round(idleMs),
    phaseBreakdown,
    byAgent,
    topByCost,
    topByLatency,
    topByWait,
    waitVsCompute: {
      computeMs: Math.round(modelComputeMs),
      waitMs: Math.round(modelWaitMs),
      ratio:
        modelComputeMs > 0
          ? Math.round((modelWaitMs / modelComputeMs) * 100) / 100
          : 0,
    },
    concurrency: {
      peakModelInFlight: peakOverlap(modelSpans),
      peakIoInFlight: peakOverlap(ioSpans),
      gateLimitModel: meta.gateLimitModel,
      gateLimitIo: meta.gateLimitIo,
    },
    anomalies: detectAnomalies(modelSpans, agentSpans),
    attribution,
  };
}
