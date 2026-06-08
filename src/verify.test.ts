import { describe, expect, it } from "vitest";
import {
  rankClaimsForVerification,
  verifyClaims,
  voteSplit,
  MAX_VERIFY_CLAIMS,
} from "./verify.js";
import {
  renderConfirmedClaims,
  renderRefutedClaims,
  synthesisPrompt,
  synthesizeReport,
} from "./synthesize.js";
import type { ResearchClaim } from "./claims.js";
import type { ModelAdapter, ModelStepInput } from "./model.js";
import { createAgentScope, type ResearchCtx } from "./runtime.js";

function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: "claim_1",
    text: "The plant produces 14,000 units per day",
    quote: "The plant produces 14,000 units per day.",
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

function verdictAdapter(
  decide: (input: ModelStepInput) => { refuted: boolean } | Error,
): ModelAdapter & { calls: ModelStepInput[] } {
  const calls: ModelStepInput[] = [];
  return {
    provider: "anthropic",
    model: "fake",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    calls,
    async step(input) {
      calls.push(input);
      if (input.outputSchema) {
        const verdict = decide(input);
        if (verdict instanceof Error) throw verdict;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                refuted: verdict.refuted,
                evidence: "checked",
                confidence: "high",
              }),
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "no tools needed" }] };
    },
  };
}

function structureAdapter(
  respond: (input: ModelStepInput) => string | Error,
): ModelAdapter & { calls: ModelStepInput[] } {
  const calls: ModelStepInput[] = [];
  return {
    provider: "anthropic",
    model: "fake",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    calls,
    async step(input) {
      calls.push(input);
      const out = respond(input);
      if (out instanceof Error) throw out;
      return { content: [{ type: "text", text: out }] };
    },
  };
}

// A voter adapter that always emits a tool call on a tool-step, so the agent
// loop only terminates via its turn backstop or token-budget governor — never
// because the model "decided" it was done. Verdict steps (outputSchema) return
// a fixed verdict. Counters are shared across the panel's voters; assert totals.
function investigatingAdapter(
  opts: { refuted?: boolean; inputTokensPerStep?: number } = {},
): ModelAdapter & { loopSteps: number; verdictSteps: number } {
  let loopSteps = 0;
  let verdictSteps = 0;
  return {
    provider: "anthropic",
    model: "fake",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    get loopSteps() {
      return loopSteps;
    },
    get verdictSteps() {
      return verdictSteps;
    },
    async step(input) {
      if (input.outputSchema) {
        verdictSteps++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                refuted: opts.refuted ?? false,
                evidence: "checked",
                confidence: "high",
              }),
            },
          ],
        };
      }
      loopSteps++;
      const content = [
        {
          type: "tool_call" as const,
          id: `t${loopSteps}`,
          name: "search_sources",
          input: { query: "x" },
        },
      ];
      return opts.inputTokensPerStep !== undefined
        ? { content, inputTokens: opts.inputTokensPerStep }
        : { content };
    },
  } as ModelAdapter & { loopSteps: number; verdictSteps: number };
}

function makeCtx(
  adapter: ModelAdapter,
  claims: ResearchClaim[],
  opts: {
    tokenLimit?: number;
    verifyTargetConfirmed?: number;
    verifierPanel?: "lens" | "clone";
    verifierMaxToolTurns?: number;
    verifierTokenBudget?: number;
  } = {},
): ResearchCtx & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    config: {
      useProxy: false,
      sourceCap: 100,
      ...(opts.tokenLimit !== undefined ? { tokenLimit: opts.tokenLimit } : {}),
      ...(opts.verifyTargetConfirmed !== undefined
        ? { verifyTargetConfirmed: opts.verifyTargetConfirmed }
        : {}),
      ...(opts.verifierPanel !== undefined
        ? { verifierPanel: opts.verifierPanel }
        : {}),
      ...(opts.verifierMaxToolTurns !== undefined
        ? { verifierMaxToolTurns: opts.verifierMaxToolTurns }
        : {}),
      ...(opts.verifierTokenBudget !== undefined
        ? { verifierTokenBudget: opts.verifierTokenBudget }
        : {}),
    },
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
        claims,
        unsupportedCount: 0,
        queue: () => {},
        settle: async () => {},
      },
    },
    scope: createAgentScope({
      sink: (event) => events.push(event as Record<string, unknown>),
      query: "test question",
    }),
    events,
  } as ResearchCtx & { events: Array<Record<string, unknown>> };
}

describe("rankClaimsForVerification", () => {
  it("orders by importance then source quality and skips non-quoted claims", () => {
    const claims = [
      claim({ id: "c1", importance: "tangential", sourceQuality: "primary" }),
      claim({ id: "c2", importance: "central", sourceQuality: "blog" }),
      claim({ id: "c3", importance: "central", sourceQuality: "primary" }),
      claim({ id: "c4", status: "unsupported" }),
    ];
    expect(rankClaimsForVerification(claims).map((entry) => entry.id)).toEqual([
      "c3",
      "c2",
      "c1",
    ]);
  });
});

describe("verifyClaims", () => {
  it("confirms a claim when at most one lens refutes", async () => {
    let votes = 0;
    const adapter = verdictAdapter(() => ({ refuted: votes++ === 0 }));
    const target = claim();
    const ctx = makeCtx(adapter, [target]);

    const summary = await verifyClaims(ctx, "test question");

    expect(summary).toMatchObject({ verified: 1, confirmed: 1, refuted: 0 });
    expect(target.status).toBe("confirmed");
    expect(target.votes).toHaveLength(4);
    expect(voteSplit(target)).toBe("3-1");
    expect(ctx.events).toContainEqual(
      expect.objectContaining({
        type: "claim_verified",
        status: "confirmed",
        vote: "3-1",
      }),
    );
  });

  it("kills a claim on two refutations", async () => {
    const adapter = verdictAdapter(() => ({ refuted: true }));
    const target = claim();
    const ctx = makeCtx(adapter, [target]);

    const summary = await verifyClaims(ctx, "test question");

    expect(summary.refuted).toBe(1);
    expect(target.status).toBe("refuted");
  });

  it("treats vote errors as abstentions and requires a quorum to survive", async () => {
    let calls = 0;
    const adapter = verdictAdapter(() => {
      calls++;
      return calls === 1 ? { refuted: false } : new Error("voter died");
    });
    const target = claim();
    const ctx = makeCtx(adapter, [target]);

    const summary = await verifyClaims(ctx, "test question");

    expect(summary.unverified).toBe(1);
    expect(target.status).toBe("unverified");
    expect(target.votes.length).toBeLessThan(2);
  });

  it("confirms a quorum-backed claim even when the contradiction lens abstained (default-survive)", async () => {
    const adapter = verdictAdapter((input) =>
      /Your lens: contradiction/.test(JSON.stringify(input.messages))
        ? new Error("contradiction abstained")
        : { refuted: false },
    );
    const target = claim();
    const ctx = makeCtx(adapter, [target]);

    const summary = await verifyClaims(ctx, "test question");

    expect(target.status).toBe("confirmed");
    expect(summary.confirmed).toBe(1);
    expect(summary.unverified).toBe(0);
    expect(target.votes.some((vote) => vote.lens === "contradiction")).toBe(
      false,
    );
  });

  it("seats an all-contradiction panel when verifierPanel is clone", async () => {
    const adapter = verdictAdapter(() => ({ refuted: false }));
    const target = claim();
    const ctx = makeCtx(adapter, [target], { verifierPanel: "clone" });

    const summary = await verifyClaims(ctx, "test question");

    expect(target.votes).toHaveLength(4);
    expect(target.votes.every((vote) => vote.lens === "contradiction")).toBe(
      true,
    );
    expect(target.status).toBe("confirmed");
    expect(summary.confirmed).toBe(1);
    const prompts = JSON.stringify(adapter.calls);
    expect(prompts).toContain("Your lens: contradiction");
    expect(prompts).not.toContain("Your lens: quote-fidelity");
    expect(prompts).not.toContain("Your lens: source-strength");
  });

  it("stops verifying once the confirmed target is met", async () => {
    const adapter = verdictAdapter(() => ({ refuted: false }));
    const claims = Array.from({ length: 60 }, (_, index) =>
      claim({ id: `c${index}` }),
    );
    const ctx = makeCtx(adapter, claims, { verifyTargetConfirmed: 25 });

    const summary = await verifyClaims(ctx, "test question");

    expect(summary.confirmed).toBeGreaterThanOrEqual(25);
    expect(summary.verified).toBeLessThan(claims.length);
    expect(summary.beyondCap).toBe(claims.length - summary.verified);
    expect(summary.beyondCap).toBeGreaterThan(0);
  });

  it("backfills past the first wave when confirmations are scarce", async () => {
    const adapter = verdictAdapter(() => ({ refuted: true }));
    const claims = Array.from({ length: 40 }, (_, index) =>
      claim({ id: `c${index}` }),
    );
    const ctx = makeCtx(adapter, claims, { verifyTargetConfirmed: 25 });

    const summary = await verifyClaims(ctx, "test question");

    expect(summary.confirmed).toBe(0);
    expect(summary.verified).toBe(40);
    expect(summary.refuted).toBe(40);
    expect(summary.beyondCap).toBe(0);
  });

  it("never verifies past the MAX_VERIFY_CLAIMS backstop", async () => {
    const adapter = verdictAdapter(() => ({ refuted: true }));
    const claims = Array.from({ length: MAX_VERIFY_CLAIMS + 20 }, (_, index) =>
      claim({ id: `c${index}` }),
    );
    const ctx = makeCtx(adapter, claims, { verifyTargetConfirmed: 1_000 });

    const summary = await verifyClaims(ctx, "test question");

    expect(summary.verified).toBeLessThanOrEqual(MAX_VERIFY_CLAIMS);
    expect(summary.beyondCap).toBe(claims.length - summary.verified);
    expect(summary.beyondCap).toBeGreaterThan(0);
  });

  it("returns immediately when nothing is verifiable", async () => {
    const adapter = verdictAdapter(() => ({ refuted: false }));
    const ctx = makeCtx(adapter, [claim({ status: "unsupported" })]);

    const summary = await verifyClaims(ctx, "test question");

    expect(summary.verified).toBe(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it("verifies nothing once the token budget is already exhausted", async () => {
    const adapter = verdictAdapter(() => ({ refuted: false }));
    adapter.usage.input_tokens = 10_000;
    const target = claim();
    const ctx = makeCtx(adapter, [target], { tokenLimit: 1_000 });

    const summary = await verifyClaims(ctx, "test question");

    expect(adapter.calls).toHaveLength(0);
    expect(target.status).toBe("quoted");
    expect(summary.verified).toBe(0);
    expect(summary.beyondCap).toBe(1);
  });

  it("lets a voter investigate past the old two-turn cap up to the backstop", async () => {
    const adapter = investigatingAdapter({ refuted: false });
    const target = claim();
    const ctx = makeCtx(adapter, [target], { verifierMaxToolTurns: 3 });

    const summary = await verifyClaims(ctx, "test question");

    // 4 seats, each runs 3 tool turns (hits the backstop) then one verdict step.
    expect(adapter.loopSteps).toBe(12);
    expect(adapter.verdictSteps).toBe(4);
    expect(target.votes).toHaveLength(4);
    expect(target.status).toBe("confirmed");
    expect(summary.confirmed).toBe(1);
  });

  it("stops a voter's investigation when its per-vote token budget is spent", async () => {
    const adapter = investigatingAdapter({
      refuted: false,
      inputTokensPerStep: 30_000,
    });
    const target = claim();
    const ctx = makeCtx(adapter, [target], {
      verifierMaxToolTurns: 8,
      verifierTokenBudget: 50_000,
    });

    const summary = await verifyClaims(ctx, "test question");

    // Budget trips after the cumulative input crosses 50k (two 30k steps),
    // well before the turn backstop of 8: 2 tool turns per voter.
    expect(adapter.loopSteps).toBe(8);
    expect(adapter.verdictSteps).toBe(4);
    expect(target.status).toBe("confirmed");
    expect(summary.confirmed).toBe(1);
  });
});

describe("synthesis rendering", () => {
  it("renders confirmed claims with vote, source, quote, and best evidence", () => {
    const confirmed = claim({
      status: "confirmed",
      publishedTime: "2024-06-01",
      votes: [
        { lens: "quote-fidelity", refuted: false, evidence: "solid", confidence: "medium" },
        { lens: "contradiction", refuted: false, evidence: "nothing found", confidence: "high" },
        { lens: "source-strength", refuted: true, evidence: "weak page", confidence: "low" },
      ],
    });
    const block = renderConfirmedClaims([confirmed]);
    expect(block).toContain("### [0] The plant produces 14,000 units per day");
    expect(block).toContain("Vote: 2-1");
    expect(block).toContain("published 2024-06-01");
    expect(block).toContain('Quote: "The plant produces 14,000 units per day."');
    expect(block).toContain("Verifier evidence (high): nothing found");
  });

  it("renders the refuted block only when refuted claims exist", () => {
    expect(renderRefutedClaims([])).toBe("");
    const refuted = claim({
      status: "refuted",
      votes: [
        { lens: "quote-fidelity", refuted: true, evidence: "", confidence: "high" },
        { lens: "contradiction", refuted: true, evidence: "", confidence: "high" },
      ],
    });
    expect(renderRefutedClaims([refuted])).toContain("vote 0-2");
  });

  it("builds a synthesis prompt that carries question, claims, and gaps", () => {
    const prompt = synthesisPrompt({
      question: "How many units per day?",
      confirmed: [
        claim({
          status: "confirmed",
          votes: [
            { lens: "contradiction", refuted: false, evidence: "ok", confidence: "high" },
            { lens: "source-strength", refuted: false, evidence: "ok", confidence: "high" },
          ],
        }),
      ],
      candidates: [],
      refuted: [],
      gapsNote: "No 2025 figures found.",
    });
    expect(prompt).toContain("**Question:** How many units per day?");
    expect(prompt).toContain("## Known gaps");
    expect(prompt).toContain("No 2025 figures found.");
    expect(prompt).toContain("Write the report");
  });

  it("renders unconfirmed candidates and tells the model to mark them low confidence", () => {
    const prompt = synthesisPrompt({
      question: "What is the race name?",
      confirmed: [],
      candidates: [
        claim({ status: "unverified", text: "The race was the Bubba Gump 5K." }),
      ],
      refuted: [],
    });
    expect(prompt).toContain("Unconfirmed candidate claims");
    expect(prompt).toContain("The race was the Bubba Gump 5K.");
    expect(prompt).toContain("low confidence");
  });
});

describe("report synthesis", () => {
  it("writes answer-first markdown directly from the claims, with no output schema", async () => {
    const adapter = structureAdapter(
      () => "42, per [the source](https://example.com/a).",
    );
    const ctx = makeCtx(adapter, []);

    const markdown = await synthesizeReport(ctx, {
      question: "What is the answer?",
      confirmed: [claim({ status: "confirmed" })],
      candidates: [],
      refuted: [],
    });

    expect(markdown).toBe("42, per [the source](https://example.com/a).");
    expect(adapter.calls[0]?.outputSchema).toBeUndefined();
    expect(adapter.calls[0]?.messages[0]?.content).toContain(
      "What is the answer?",
    );
  });
});
