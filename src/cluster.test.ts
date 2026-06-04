import { describe, expect, it } from "vitest";
import { clusterClaims } from "./cluster.js";
import type { ResearchClaim } from "./claims.js";
import type { ModelAdapter } from "./model.js";
import { createAgentScope, type ResearchCtx } from "./runtime.js";

function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: "claim_1",
    text: "A fact",
    quote: "A fact.",
    importance: "central",
    sourceQuality: "secondary",
    sourceId: "source_1",
    url: "https://example.com/a",
    title: "Example",
    status: "quoted",
    votes: [],
    ...overrides,
  };
}

function clusterAdapter(reply: (() => string) | Error): ModelAdapter {
  return {
    provider: "anthropic",
    model: "fake",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    async step() {
      if (reply instanceof Error) throw reply;
      return { content: [{ type: "text", text: reply() }] };
    },
  };
}

function makeCtx(adapter: ModelAdapter): ResearchCtx {
  return {
    config: { useProxy: false, sourceCap: 100 },
    deps: {
      model: adapter,
      steel: {} as ResearchCtx["deps"]["steel"],
      throwIfAborted: () => {},
      ioGate: { run: (fn) => fn() },
      browserSessionPool:
        {} as unknown as ResearchCtx["deps"]["browserSessionPool"],
    },
    store: {
      fetchedSources: [],
      sourceDocuments: new Map(),
      sourceDocumentsById: new Map(),
      sourceReservations: {
        urls: new Set(),
        sourceSlots: 0,
        nextSourceNumber: 1,
        documents: new Map(),
      },
      caches: { serp: new Map(), sources: new Map() },
      claims: {
        claims: [],
        unsupportedCount: 0,
        queue: () => {},
        settle: async () => {},
      },
    },
    scope: createAgentScope({ sink: () => {}, query: "q" }),
  } as ResearchCtx;
}

describe("clusterClaims", () => {
  it("merges equivalent claims, keeping the highest-ranked as representative", async () => {
    const a = claim({ id: "c0", sourceId: "source_1", url: "https://a.com" });
    const b = claim({ id: "c1", sourceId: "source_2", url: "https://b.com" });
    const c = claim({ id: "c2", sourceId: "source_3", url: "https://c.com" });
    const ctx = makeCtx(
      clusterAdapter(() =>
        JSON.stringify({ clusters: [{ claimIds: ["c1", "c0"] }] }),
      ),
    );

    const outcome = await clusterClaims(ctx, [a, b, c]);

    expect(outcome).toEqual({ clustersFormed: 1, claimsDeduped: 1 });
    expect(a.duplicateOf).toBeUndefined();
    expect(b.duplicateOf).toBe("c0");
    expect(c.duplicateOf).toBeUndefined();
    expect(a.corroboration).toBe(2);
    expect(a.corroboratingSources).toEqual(["https://a.com", "https://b.com"]);
  });

  it("counts distinct sources, not claims, for corroboration", async () => {
    const a = claim({ id: "c0", sourceId: "source_1", url: "https://a.com" });
    const b = claim({ id: "c1", sourceId: "source_1", url: "https://a.com" });
    const ctx = makeCtx(
      clusterAdapter(() =>
        JSON.stringify({ clusters: [{ claimIds: ["c0", "c1"] }] }),
      ),
    );

    await clusterClaims(ctx, [a, b]);

    expect(b.duplicateOf).toBe("c0");
    expect(a.corroboration).toBe(1);
  });

  it("ignores unknown ids and singleton groups", async () => {
    const a = claim({ id: "c0" });
    const b = claim({ id: "c1" });
    const ctx = makeCtx(
      clusterAdapter(() =>
        JSON.stringify({
          clusters: [{ claimIds: ["c0", "ghost"] }, { claimIds: ["c1"] }],
        }),
      ),
    );

    const outcome = await clusterClaims(ctx, [a, b]);

    expect(outcome).toEqual({ clustersFormed: 0, claimsDeduped: 0 });
    expect(a.duplicateOf).toBeUndefined();
    expect(b.duplicateOf).toBeUndefined();
  });

  it("falls back to no clustering when the model errors", async () => {
    const a = claim({ id: "c0" });
    const b = claim({ id: "c1" });
    const ctx = makeCtx(clusterAdapter(new Error("model down")));

    const outcome = await clusterClaims(ctx, [a, b]);

    expect(outcome).toEqual({ clustersFormed: 0, claimsDeduped: 0 });
    expect(a.duplicateOf).toBeUndefined();
  });

  it("does not call the model for fewer than two claims", async () => {
    let called = 0;
    const ctx = makeCtx(
      clusterAdapter(() => {
        called++;
        return "{}";
      }),
    );

    const outcome = await clusterClaims(ctx, [claim()]);

    expect(outcome).toEqual({ clustersFormed: 0, claimsDeduped: 0 });
    expect(called).toBe(0);
  });
});
