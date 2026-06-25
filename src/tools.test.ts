import { describe, expect, it } from "vitest";
import type { RunCtx } from "./state.js";
import { type AgentCtx, buildAgentTools, execSearchTool } from "./tools.js";

describe("run_code tool gating", () => {
  const actx = { agentId: "agent_1", role: "research" } as AgentCtx;
  const gateRctx = (runCodeEnabled: boolean) =>
    ({ customTools: new Map(), runCodeEnabled }) as unknown as RunCtx;

  it("registers run_code when the sandbox is available", () => {
    const tools = buildAgentTools(gateRctx(true), actx, ["run_code"]);
    expect(tools.run_code).toBeDefined();
  });

  it("omits run_code when the sandbox is unavailable", () => {
    const tools = buildAgentTools(gateRctx(false), actx, ["run_code"]);
    expect(tools.run_code).toBeUndefined();
  });
});

describe("execSearchTool live cache", () => {
  function searchRctx(calls: { count: number }) {
    return {
      replay: undefined,
      ioGate: { run: <T>(fn: () => Promise<T>) => fn() },
      signal: undefined,
      journal: undefined,
      recorder: undefined,
      config: {},
      counters: { searches: 0, searchCacheHits: 0 },
      sources: { searchCache: new Map(), byUrl: new Map() },
      surfacedCandidates: new Map(),
      trail: { recordSearch: () => {} },
      emit: () => {},
      search: {
        providers: [{ id: "stub" }],
        run: async ({ query }: { query: string }) => {
          calls.count++;
          return {
            merged: [
              {
                title: `T:${query}`,
                url: `https://example.com/${calls.count}`,
                snippet: "s",
                provider: "stub",
                providerRank: 1,
                providers: ["stub"],
                score: 1,
              },
            ],
            warnings: [],
          };
        },
      },
    } as unknown as RunCtx;
  }

  it("serves identical normalized queries from the run cache", async () => {
    const calls = { count: 0 };
    const rctx = searchRctx(calls);
    await execSearchTool(rctx, ["cold start lambda"], 8);
    await execSearchTool(rctx, ["Lambda  Cold  Start"], 8);
    expect(calls.count).toBe(1);
    expect(rctx.counters.searchCacheHits).toBe(1);
    expect(rctx.counters.searches).toBe(2);
  });

  it("serves the same query across different result limits from the cache", async () => {
    const calls = { count: 0 };
    const rctx = searchRctx(calls);
    await execSearchTool(rctx, ["cold start lambda"], 8);
    await execSearchTool(rctx, ["cold start lambda"], 15);
    expect(calls.count).toBe(1);
    expect(rctx.counters.searchCacheHits).toBe(1);
  });

  it("issues distinct network calls for genuinely different queries", async () => {
    const calls = { count: 0 };
    const rctx = searchRctx(calls);
    await execSearchTool(rctx, ["lambda pricing"], 8);
    await execSearchTool(rctx, ["workers pricing"], 8);
    expect(calls.count).toBe(2);
    expect(rctx.counters.searchCacheHits).toBe(0);
  });
});
