import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyUsageSummary,
  type ModelAdapter,
  type ModelAssistantBlock,
  type ModelStepInput,
  type ModelToolCall,
} from "./model.js";
import { renderLedgerDigest, runGapLoop } from "./research-loop.js";
import { executeResearchTool } from "./tool-registry.js";
import { LEAD_SYSTEM_PROMPT } from "./tool-contract.js";
import { createAgentScope, type ResearchCtx } from "./runtime.js";
import type { RecallOutcome } from "./recall.js";
import type { ResearchClaim } from "./claims.js";

vi.mock("./tool-registry.js", () => ({
  researchToolDefinitions: () => [
    {
      name: "survey",
      description: "survey",
      input_schema: { type: "object" },
    },
    {
      name: "search",
      description: "search",
      input_schema: { type: "object" },
    },
    {
      name: "read_source",
      description: "read",
      input_schema: { type: "object" },
    },
  ],
  toolSpendsActionBudget: (name: string) => name !== "read_source",
  executeResearchTool: vi.fn(),
}));

const executeToolMock = vi.mocked(executeResearchTool);

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ModelToolCall {
  return { type: "tool_call", id, name, input };
}

function scriptedAdapter(steps: ModelAssistantBlock[][]): {
  adapter: ModelAdapter;
  calls: ModelStepInput[];
} {
  const calls: ModelStepInput[] = [];
  let index = 0;
  const adapter: ModelAdapter = {
    provider: "anthropic",
    model: "test-model",
    usage: emptyUsageSummary(),
    async step(input) {
      calls.push(input);
      const content = steps[Math.min(index, steps.length - 1)];
      index++;
      return { content };
    },
  };
  return { adapter, calls };
}

function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: "claim_1",
    text: "Fact one",
    quote: "Fact one.",
    importance: "central",
    sourceQuality: "primary",
    sourceId: "source_1",
    url: "https://example.com/a",
    title: "Example",
    status: "quoted",
    votes: [],
    ...overrides,
  };
}

function recallOutcome(overrides: Partial<RecallOutcome> = {}): RecallOutcome {
  return {
    angles: [{ label: "primary", query: "alpha" }],
    strategy: "single angle",
    sourcesFetched: 1,
    urlDupes: 0,
    budgetDropped: 0,
    claimsExtracted: 1,
    searchQueriesRun: 1,
    ...overrides,
  };
}

function makeCtx(opts: {
  adapter: ModelAdapter;
  claims?: ResearchClaim[];
  tokenLimit?: number;
  deadlineAt?: number;
  synthesisReserveMs?: number;
  stopSignal?: AbortSignal;
  instructions?: string;
}): ResearchCtx & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    config: {
      useProxy: false,
      sourceCap: 100,
      maxConcurrentTools: 2,
      ...(opts.tokenLimit !== undefined ? { tokenLimit: opts.tokenLimit } : {}),
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    },
    deps: {
      model: opts.adapter,
      steel: {} as ResearchCtx["deps"]["steel"],
      ...(opts.stopSignal ? { stopSignal: opts.stopSignal } : {}),
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
        claims: opts.claims ?? [],
        unsupportedCount: 0,
        queue: () => {},
        settle: async () => {},
      },
    },
    scope: createAgentScope({
      sink: (event) => events.push(event as Record<string, unknown>),
      query: "test question",
      deadlineAt: opts.deadlineAt,
      synthesisReserveMs: opts.synthesisReserveMs,
    }),
    events,
  } as ResearchCtx & { events: Array<Record<string, unknown>> };
}

beforeEach(() => {
  executeToolMock.mockReset();
  executeToolMock.mockImplementation(async (tu, _ctx, extras) => {
    if (tu.name === "survey") {
      const goal = String(
        (tu.input as { goal?: string } | undefined)?.goal ?? "",
      );
      extras.surveyedGoals.push(goal);
    }
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: "ok",
      },
    };
  });
});

describe("renderLedgerDigest", () => {
  it("renders one line per claim with id, importance, quality, and host", () => {
    const digest = renderLedgerDigest([
      claim(),
      claim({
        id: "claim_2",
        text: "Fact two",
        importance: "supporting",
        sourceQuality: "blog",
        url: "https://www.blog.net/post",
        sourceId: "source_2",
      }),
    ]);
    expect(digest).toContain(
      "[claim_1·central·primary] Fact one — example.com (source_1)",
    );
    expect(digest).toContain(
      "[claim_2·supporting·blog] Fact two — blog.net (source_2)",
    );
  });

  it("caps the digest and reports the overflow", () => {
    const claims = Array.from({ length: 65 }, (_, index) =>
      claim({ id: `claim_${index}` }),
    );
    const digest = renderLedgerDigest(claims);
    expect(digest).toContain("…and 5 more claims");
  });
});

describe("runGapLoop", () => {
  it("anchors the lead on the question, scope, and ledger digest", async () => {
    const { adapter, calls } = scriptedAdapter([
      [{ type: "text", text: "Ledger covers the question; no gaps remain." }],
    ]);
    const ctx = makeCtx({ adapter, claims: [claim()] });

    const result = await runGapLoop({
      ctx,
      question: "test question",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.gapsNote).toBe(
      "Ledger covers the question; no gaps remain.",
    );
    expect(result.finishReason).toBe("gaps assessed");
    expect(calls[0]?.system).toBe(LEAD_SYSTEM_PROMPT);
    const anchor = String(calls[0]?.messages[0]?.content);
    expect(anchor).toContain("Research question: test question");
    expect(anchor).toContain("single angle");
    expect(anchor).toContain("[claim_1·central·primary] Fact one");
  });

  it("appends extra instructions to the system prompt", async () => {
    const { adapter, calls } = scriptedAdapter([
      [{ type: "text", text: "done" }],
    ]);
    const ctx = makeCtx({ adapter, instructions: "Prefer primary sources." });

    await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(calls[0]?.system).toBe(
      `${LEAD_SYSTEM_PROMPT}\n\nPrefer primary sources.`,
    );
  });

  it("executes tool calls, tracks budgets, and feeds results back", async () => {
    const { adapter, calls } = scriptedAdapter([
      [
        toolUse("t1", "survey", { goal: "missing 2024 figures" }),
        toolUse("t2", "read_source", { source_id: "source_1" }),
      ],
      [{ type: "text", text: "gaps closed" }],
    ]);
    const ctx = makeCtx({ adapter });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.toolCalls).toBe(1);
    expect(result.totalToolExecutions).toBe(2);
    expect(result.surveys).toBe(1);
    expect(result.gapsNote).toBe("gaps closed");
    const followup = calls[1]?.messages.at(-1);
    expect(followup?.role).toBe("user");
    expect(
      Array.isArray(followup?.content) ? followup.content : [],
    ).toHaveLength(2);
  });

  it("skips tools beyond the action budget and reports the skip", async () => {
    const { adapter, calls } = scriptedAdapter([
      [
        toolUse("t1", "survey", { goal: "gap one" }),
        toolUse("t2", "survey", { goal: "gap two" }),
      ],
      [{ type: "text", text: "stopping" }],
    ]);
    const ctx = makeCtx({ adapter });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 1,
    });

    expect(result.finishReason).toBe("tool call budget exhausted");
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const followup = calls.at(-1)?.messages.at(-1);
    const results = Array.isArray(followup?.content) ? followup.content : [];
    expect(
      results.some(
        (entry) =>
          "content" in entry && String(entry.content).includes("Tool not run"),
      ),
    ).toBe(true);
  });

  it("re-anchors onto the current ledger when the transcript grows too large", async () => {
    executeToolMock.mockImplementation(async (tu, _ctx, extras) => {
      if (tu.name === "survey") {
        const goal = String(
          (tu.input as { goal?: string } | undefined)?.goal ?? "",
        );
        extras.surveyedGoals.push(goal);
      }
      return {
        toolResult: {
          type: "tool_result",
          tool_call_id: tu.id,
          content: "x".repeat(700_000),
        },
      };
    });
    const { adapter, calls } = scriptedAdapter([
      [toolUse("t1", "survey", { goal: "first gap" })],
      [{ type: "text", text: "done after reanchor" }],
    ]);
    const ctx = makeCtx({ adapter, claims: [claim()] });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.reanchors).toBe(1);
    expect(ctx.events).toContainEqual(
      expect.objectContaining({
        type: "context_reanchored",
        droppedMessages: 3,
      }),
    );
    const reanchoredMessages = calls[1]?.messages;
    expect(reanchoredMessages).toHaveLength(1);
    const anchor = String(reanchoredMessages?.[0]?.content);
    expect(anchor).toContain("Context was re-anchored");
    expect(anchor).toContain("- first gap");
  });

  it("nudges once on an empty response then accepts the gap note", async () => {
    const { adapter, calls } = scriptedAdapter([
      [{ type: "thinking", thinking: "hmm", signature: "" }],
      [{ type: "text", text: "note after nudge" }],
    ]);
    const ctx = makeCtx({ adapter });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.gapsNote).toBe("note after nudge");
    expect(calls).toHaveLength(2);
    const nudge = calls[1]?.messages.at(-1);
    expect(String(nudge?.content)).toContain("no tool calls and no text");
  });

  it("stops before stepping once the token budget is exhausted", async () => {
    const { adapter } = scriptedAdapter([[{ type: "text", text: "unused" }]]);
    adapter.usage.input_tokens = 10_000;
    const ctx = makeCtx({ adapter, tokenLimit: 1_000 });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.finishReason).toBe("token budget exhausted");
    expect(result.gapsNote).toBe("");
  });

  it("stops when the deadline leaves only the synthesis reserve", async () => {
    const { adapter } = scriptedAdapter([[{ type: "text", text: "unused" }]]);
    const ctx = makeCtx({
      adapter,
      deadlineAt: Date.now() + 1_000,
      synthesisReserveMs: 60_000,
    });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.finishReason).toMatch(/^timeout approaching/);
  });

  it("stops when a soft stop is requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter } = scriptedAdapter([[{ type: "text", text: "unused" }]]);
    const ctx = makeCtx({ adapter, stopSignal: controller.signal });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.finishReason).toBe("stop requested");
  });

  it("records an api error as the finish reason", async () => {
    const adapter: ModelAdapter = {
      provider: "anthropic",
      model: "test-model",
      usage: emptyUsageSummary(),
      async step() {
        throw new Error("model exploded");
      },
    };
    const ctx = makeCtx({ adapter });

    const result = await runGapLoop({
      ctx,
      question: "q",
      recall: recallOutcome(),
      maxToolCalls: 10,
    });

    expect(result.finishReason).toBe("api error: model exploded");
  });
});
