import { describe, expect, it, vi } from "vitest";
import {
  createClaimLedger,
  normalizeForQuoteMatch,
  quoteAppearsInSource,
} from "./claims.js";
import type { ModelAdapter, ModelStepInput } from "./model.js";
import { createAgentScope, type ResearchCtx } from "./runtime.js";
import { createSourceDocument } from "./source-documents.js";
import type { SourceDocument } from "./sources.js";

function fakeAdapter(
  respond: (input: ModelStepInput) => unknown,
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
      const value = respond(input);
      if (value instanceof Error) throw value;
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
      };
    },
  };
}

function makeDocument(
  markdown: string,
  opts: { sourceId?: string; qualityWarnings?: string[] } = {},
): SourceDocument {
  return createSourceDocument(
    "https://example.com/page",
    "Example Page",
    markdown,
    {
      markdownChars: markdown.length,
      extractionNotes: [],
      ...(opts.qualityWarnings ? { qualityWarnings: opts.qualityWarnings } : {}),
    },
    markdown.length,
    opts.sourceId ?? "source_1",
  );
}

function makeCtx(
  adapter: ModelAdapter,
  opts: { tokenLimit?: number } = {},
): ResearchCtx & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    config: {
      useProxy: false,
      sourceCap: 100,
      ...(opts.tokenLimit !== undefined ? { tokenLimit: opts.tokenLimit } : {}),
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
      caches: { serp: new Map(), sources: new Map(), summaries: new Map() },
      claims: { claims: [], queue: () => {}, settle: async () => {} },
    },
    scope: createAgentScope({
      sink: (event) => events.push(event),
      query: "test question",
      depth: 0,
    }),
    events,
  } as ResearchCtx & { events: unknown[] };
}

const LONG_FILLER = "Background context sentence for padding. ".repeat(10);

describe("normalizeForQuoteMatch", () => {
  it("collapses whitespace and folds typographic punctuation", () => {
    expect(normalizeForQuoteMatch("  “Smart—Quotes”\n\tand   spaces ")).toBe(
      '"smart-quotes" and spaces',
    );
  });
});

describe("quoteAppearsInSource", () => {
  it("matches verbatim text despite whitespace and quote-style differences", () => {
    const source = "Revenue grew to “$4.2M” in\nQ3 2024 — a record.";
    expect(quoteAppearsInSource('Revenue grew to "$4.2M" in Q3 2024', source)).toBe(
      true,
    );
  });

  it("rejects paraphrased quotes", () => {
    const source = "Revenue grew to $4.2M in Q3 2024.";
    expect(quoteAppearsInSource("Revenue rose to about $4M", source)).toBe(
      false,
    );
  });

  it("rejects empty quotes", () => {
    expect(quoteAppearsInSource("", "anything")).toBe(false);
  });
});

describe("createClaimLedger", () => {
  it("extracts claims, keeps verbatim-supported ones, drops the rest", async () => {
    const markdown = `${LONG_FILLER}The plant produces 14,000 units per day. ${LONG_FILLER}`;
    const adapter = fakeAdapter(() => ({
      sourceQuality: "secondary",
      claims: [
        {
          claim: "The plant produces 14,000 units per day",
          quote: "The plant produces 14,000 units per day.",
          importance: "central",
        },
        {
          claim: "The plant is the largest in Europe",
          quote: "It is by far the largest factory in Europe.",
          importance: "supporting",
        },
      ],
    }));
    const ctx = makeCtx(adapter);
    const ledger = createClaimLedger();

    ledger.queue(ctx, makeDocument(markdown));
    await ledger.settle();

    expect(ledger.claims).toHaveLength(1);
    expect(ledger.claims[0]).toMatchObject({
      id: "claim_1",
      status: "quoted",
      importance: "central",
      sourceQuality: "secondary",
      sourceId: "source_1",
    });
    expect(ctx.events).toContainEqual(
      expect.objectContaining({
        type: "claims_extracted",
        sourceId: "source_1",
        count: 1,
        unsupported: 1,
      }),
    );
  });

  it("queues each source only once", async () => {
    const adapter = fakeAdapter(() => ({ sourceQuality: "blog", claims: [] }));
    const ctx = makeCtx(adapter);
    const ledger = createClaimLedger();
    const document = makeDocument(LONG_FILLER);

    ledger.queue(ctx, document);
    ledger.queue(ctx, document);
    await ledger.settle();

    expect(adapter.calls).toHaveLength(1);
  });

  it("skips blocked, thin, and listing-page sources", async () => {
    const step = vi.fn();
    const adapter = fakeAdapter(step);
    const ctx = makeCtx(adapter);
    const ledger = createClaimLedger();

    ledger.queue(
      ctx,
      makeDocument(LONG_FILLER, {
        sourceId: "source_1",
        qualityWarnings: ["blocked_or_challenge: looks like a bot wall"],
      }),
    );
    ledger.queue(
      ctx,
      makeDocument(LONG_FILLER, {
        sourceId: "source_2",
        qualityWarnings: ["search_listing_page: SERP-like content"],
      }),
    );
    ledger.queue(ctx, makeDocument("tiny", { sourceId: "source_3" }));
    await ledger.settle();

    expect(step).not.toHaveBeenCalled();
    expect(ledger.claims).toHaveLength(0);
  });

  it("skips extraction once the token budget is exhausted", async () => {
    const adapter = fakeAdapter(() => ({ sourceQuality: "blog", claims: [] }));
    adapter.usage.input_tokens = 5_000;
    const ctx = makeCtx(adapter, { tokenLimit: 1_000 });
    const ledger = createClaimLedger();

    ledger.queue(ctx, makeDocument(LONG_FILLER));
    await ledger.settle();

    expect(adapter.calls).toHaveLength(0);
  });

  it("emits an error event when extraction fails", async () => {
    const adapter = fakeAdapter(() => new Error("model unavailable"));
    const ctx = makeCtx(adapter);
    const ledger = createClaimLedger();

    ledger.queue(ctx, makeDocument(LONG_FILLER));
    await ledger.settle();

    expect(ledger.claims).toHaveLength(0);
    expect(ctx.events).toContainEqual(
      expect.objectContaining({
        type: "claims_extracted",
        count: 0,
        error: "model unavailable",
      }),
    );
  });

  it("coerces unknown enum values and tolerates malformed output", async () => {
    const markdown = `${LONG_FILLER}Exact sentence to quote here. ${LONG_FILLER}`;
    const adapter = fakeAdapter(() => ({
      sourceQuality: "amazing",
      claims: [
        {
          claim: "A claim",
          quote: "Exact sentence to quote here.",
          importance: "critical",
        },
      ],
    }));
    const ctx = makeCtx(adapter);
    const ledger = createClaimLedger();

    ledger.queue(ctx, makeDocument(markdown));
    await ledger.settle();

    expect(ledger.claims[0]).toMatchObject({
      importance: "tangential",
      sourceQuality: "unreliable",
    });
  });

  it("prefers document metadata publishedTime over model output", async () => {
    const markdown = `${LONG_FILLER}Quoted sentence for the claim. ${LONG_FILLER}`;
    const adapter = fakeAdapter(() => ({
      sourceQuality: "primary",
      publishDate: "2020-01-01",
      claims: [
        {
          claim: "Something",
          quote: "Quoted sentence for the claim.",
          importance: "central",
        },
      ],
    }));
    const ctx = makeCtx(adapter);
    const ledger = createClaimLedger();
    const document = createSourceDocument(
      "https://example.com/dated",
      "Dated",
      markdown,
      {
        markdownChars: markdown.length,
        extractionNotes: [],
        publishedTime: "2024-06-01",
      },
      markdown.length,
      "source_9",
    );

    ledger.queue(ctx, document);
    await ledger.settle();

    expect(ledger.claims[0]?.publishedTime).toBe("2024-06-01");
  });
});
