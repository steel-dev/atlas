import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  createLedger,
  normalizeForQuoteMatch,
  quoteAppearsInSource,
  renderLedgerDigest,
  type Ledger,
} from "./ledger.js";
import { createSourceDocument } from "./source-documents.js";
import type { SourceDocument } from "./sources.js";

function extractionModel(
  claims: Array<{ claim: string; quote: string; importance: string }>,
): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sourceQuality: "secondary", claims }),
        },
      ],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 100,
          noCache: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      },
      warnings: [],
    },
  }) as LanguageModelV3;
}

function makeDocument(
  sourceId: string,
  url: string,
  text: string,
): SourceDocument {
  const padded = text.padEnd(250, " filler text to clear the minimum");
  return createSourceDocument(
    url,
    "Test page",
    padded,
    { markdownChars: padded.length, extractionNotes: [] },
    padded.length,
    sourceId,
  );
}

function makeLedger(): Ledger {
  return createLedger({
    emit: () => {},
    signal: undefined,
    shouldExtract: () => true,
  });
}

describe("quote matching", () => {
  it("normalizes smart quotes and whitespace", () => {
    expect(normalizeForQuoteMatch("“Hello — World”")).toBe('"hello - world"');
    expect(
      quoteAppearsInSource("Hello — World", "it said “hello — world” loudly"),
    ).toBe(true);
  });
});

describe("ledger extraction and merge", () => {
  it("admits quote-supported claims and drops unsupported quotes", async () => {
    const ledger = makeLedger();
    const document = makeDocument(
      "source_1",
      "https://a.example.com/page",
      "The tower is 330 meters tall and was built in 1889.",
    );
    ledger.queue(document, {
      goal: "tower facts",
      agentId: "agent_1",
      model: extractionModel([
        {
          claim: "The tower is 330 meters tall",
          quote: "330 meters tall",
          importance: "central",
        },
        {
          claim: "The tower is painted blue",
          quote: "painted bright blue",
          importance: "supporting",
        },
      ]),
    });
    await ledger.settle();
    expect(ledger.claims).toHaveLength(1);
    expect(ledger.claims[0].text).toBe("The tower is 330 meters tall");
    expect(ledger.claims[0].agentId).toBe("agent_1");
    expect(ledger.unsupportedCount).toBe(1);
  });

  it("drops exact duplicates from the same domain", async () => {
    const ledger = makeLedger();
    const text = "The tower is 330 meters tall today.";
    const claims = [
      {
        claim: "The tower is 330 meters tall",
        quote: "330 meters tall",
        importance: "central",
      },
    ];
    ledger.queue(makeDocument("source_1", "https://a.example.com/1", text), {
      goal: "g",
      agentId: "agent_1",
      model: extractionModel(claims),
    });
    await ledger.settle();
    ledger.queue(makeDocument("source_2", "https://a.example.com/2", text), {
      goal: "g",
      agentId: "agent_2",
      model: extractionModel(claims),
    });
    await ledger.settle();
    expect(ledger.representatives()).toHaveLength(1);
    expect(ledger.dupesDropped).toBe(1);
  });

  it("merges cross-domain duplicates as corroboration", async () => {
    const ledger = makeLedger();
    const text = "The tower is 330 meters tall today.";
    const claims = [
      {
        claim: "The tower is 330 meters tall",
        quote: "330 meters tall",
        importance: "central",
      },
    ];
    ledger.queue(makeDocument("source_1", "https://a.example.com/1", text), {
      goal: "g",
      agentId: "agent_1",
      model: extractionModel(claims),
    });
    await ledger.settle();
    ledger.queue(makeDocument("source_2", "https://b.example.org/2", text), {
      goal: "g",
      agentId: "agent_2",
      model: extractionModel(claims),
    });
    await ledger.settle();
    const representatives = ledger.representatives();
    expect(representatives).toHaveLength(1);
    expect(representatives[0].corroboration).toBe(2);
    expect(representatives[0].corroboratingSources).toContain(
      "https://b.example.org/2",
    );
    expect(ledger.claims).toHaveLength(2);
    expect(ledger.claims[1].duplicateOf).toBe(representatives[0].id);
    expect(ledger.dupesDropped).toBe(0);
  });
});

describe("ledger flush", () => {
  function deferredExtractionModel(
    claims: Array<{ claim: string; quote: string; importance: string }>,
    gate: Promise<void>,
  ): LanguageModelV3 {
    return new MockLanguageModelV3({
      doGenerate: async () => {
        await gate;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sourceQuality: "secondary", claims }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 100,
              noCache: 100,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 50, text: 50, reasoning: 0 },
          },
          warnings: [],
        };
      },
    }) as LanguageModelV3;
  }

  it("waits for the agent's pending extractions", async () => {
    const ledger = makeLedger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ledger.queue(
      makeDocument(
        "source_1",
        "https://a.example.com/1",
        "The tower is 330 meters tall today.",
      ),
      {
        goal: "g",
        agentId: "agent_1",
        model: deferredExtractionModel(
          [
            {
              claim: "The tower is 330 meters tall",
              quote: "330 meters tall",
              importance: "central",
            },
          ],
          gate,
        ),
      },
    );
    const flushed = ledger.flush("agent_1").then(() => ledger.claims.length);
    expect(ledger.claims).toHaveLength(0);
    release();
    expect(await flushed).toBe(1);
  });

  it("does not wait on other agents' extractions", async () => {
    const ledger = makeLedger();
    const gate = new Promise<void>(() => {});
    ledger.queue(
      makeDocument(
        "source_1",
        "https://a.example.com/1",
        "The tower is 330 meters tall today.",
      ),
      {
        goal: "g",
        agentId: "agent_1",
        model: deferredExtractionModel([], gate),
      },
    );
    await ledger.flush("agent_2");
    expect(ledger.claims).toHaveLength(0);
  });
});

describe("renderLedgerDigest", () => {
  it("renders representatives with corroboration and hides duplicates", async () => {
    const ledger = makeLedger();
    const text = "The tower is 330 meters tall today.";
    const claims = [
      {
        claim: "The tower is 330 meters tall",
        quote: "330 meters tall",
        importance: "central",
      },
    ];
    ledger.queue(makeDocument("source_1", "https://a.example.com/1", text), {
      goal: "g",
      agentId: "agent_1",
      model: extractionModel(claims),
    });
    ledger.queue(makeDocument("source_2", "https://b.example.org/2", text), {
      goal: "g",
      agentId: "agent_1",
      model: extractionModel(claims),
    });
    await ledger.settle();
    const digest = renderLedgerDigest(ledger.claims);
    expect(digest.split("\n")).toHaveLength(1);
    expect(digest).toContain("×2 sources");
    expect(digest).toContain("central");
  });
});
