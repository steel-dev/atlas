import { describe, expect, it } from "vitest";
import { createLedger } from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import type { RunCtx } from "./state.js";
import {
  buildAgentTools,
  fetchOneUrl,
  type AgentCtx,
} from "./tools.js";

function fakeRctx() {
  const markdown =
    "The tower is 330 meters tall and was built in 1889.".padEnd(
      250,
      " filler",
    );
  const document = createSourceDocument(
    "https://a.example.com/page",
    "Tower",
    markdown,
    { markdownChars: markdown.length, extractionNotes: [] },
    markdown.length,
    "source_1",
  );
  const ledger = createLedger({
    emit: () => {},
    signal: undefined,
    shouldExtract: () => true,
  });
  const rctx = {
    ledger,
    sources: { byId: new Map([["source_1", document]]) },
    customTools: new Map(),
  } as unknown as RunCtx;
  return rctx;
}

function addClaimTool(rctx: RunCtx) {
  const actx = { agentId: "agent_1", role: "research" } as AgentCtx;
  const tools = buildAgentTools(rctx, actx, ["add_claim"]);
  return async (input: Record<string, unknown>): Promise<string> => {
    const execute = tools.add_claim?.execute;
    if (!execute) throw new Error("add_claim tool missing");
    return (await execute(input, {
      toolCallId: "call_1",
      messages: [],
    })) as string;
  };
}

describe("add_claim tool", () => {
  it("mints a verbatim-quoted claim into the ledger", async () => {
    const rctx = fakeRctx();
    const run = addClaimTool(rctx);
    const reply = await run({
      source_id: "source_1",
      claim: "The tower was built in 1889",
      quote: "built in 1889",
      importance: "central",
    });
    expect(reply).toBe("Added claim_1 [central·secondary] to the ledger.");
    expect(rctx.ledger.byId("claim_1")?.text).toBe(
      "The tower was built in 1889",
    );
  });

  it("rejects non-verbatim quotes with guidance", async () => {
    const rctx = fakeRctx();
    const run = addClaimTool(rctx);
    const reply = await run({
      source_id: "source_1",
      claim: "The tower is about 330m",
      quote: "approximately 330m",
      importance: "supporting",
    });
    expect(reply).toContain("Rejected");
    expect(reply).toContain("read_source");
    expect(rctx.ledger.claims).toHaveLength(0);
  });

  it("errors on unknown source ids", async () => {
    const run = addClaimTool(fakeRctx());
    const reply = await run({
      source_id: "source_404",
      claim: "x",
      quote: "x",
      importance: "tangential",
    });
    expect(reply).toBe("Error: unknown source_id: source_404");
  });
});

describe("fetch extraction by role", () => {
  function replayRctx(queued: { count: number }) {
    const markdown =
      "The tower is 330 meters tall and was built in 1889.".padEnd(
        250,
        " filler",
      );
    return {
      config: {
        safety: { allowPrivateNetworks: true },
        maxSources: 5,
      },
      seenDomains: new Set<string>(),
      sources: {
        fetchedSources: [],
        byUrl: new Map(),
        byId: new Map(),
        inFlight: new Map(),
        reservedUrls: new Set<string>(),
        reservedSlots: 0,
        nextSourceNumber: 1,
      },
      replay: {
        take: () => ({
          url: "https://a.example.com/page",
          sourceId: "source_1",
          title: "Tower",
          markdown,
          metadata: { markdownChars: markdown.length, extractionNotes: [] },
          originalChars: markdown.length,
          renderedWith: "basic",
        }),
      },
      ledger: {
        queue: () => {
          queued.count++;
        },
      },
      trail: { recordDeadEnd: () => {} },
      counters: { sourcesFetched: 0, sourcesFailed: 0 },
      emit: () => {},
      signal: undefined,
    } as unknown as RunCtx;
  }

  it("queues claim extraction for research-role fetches", async () => {
    const queued = { count: 0 };
    const rctx = replayRctx(queued);
    const actx = { agentId: "agent_1", role: "research" } as AgentCtx;
    const outcome = await fetchOneUrl(
      rctx,
      actx,
      "https://a.example.com/page",
      200,
      "goal",
    );
    expect(outcome.ok).toBe(true);
    expect(queued.count).toBe(1);
    expect(rctx.sources.byId.has("source_1")).toBe(true);
  });

  it("stores verifier-fetched pages without queuing extraction", async () => {
    const queued = { count: 0 };
    const rctx = replayRctx(queued);
    const actx = { agentId: "agent_2", role: "verify" } as AgentCtx;
    const outcome = await fetchOneUrl(
      rctx,
      actx,
      "https://a.example.com/page",
      200,
      "goal",
    );
    expect(outcome.ok).toBe(true);
    expect(queued.count).toBe(0);
    expect(rctx.sources.byId.has("source_1")).toBe(true);
    expect(rctx.counters.sourcesFetched).toBe(1);
  });
});
