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
  sourceQuality = "secondary",
): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sourceQuality, claims }),
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

  it("adopts the better source quality from corroborating sources", async () => {
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
      model: extractionModel(claims, "blog"),
    });
    await ledger.settle();
    ledger.queue(makeDocument("source_2", "https://b.example.org/2", text), {
      goal: "g",
      agentId: "agent_2",
      model: extractionModel(claims, "primary"),
    });
    await ledger.settle();
    const [representative] = ledger.representatives();
    expect(representative.corroboration).toBe(2);
    expect(representative.sourceQuality).toBe("primary");
  });

  it("treats syndicated mirrors as the same source", () => {
    const ledger = makeLedger();
    const article =
      Array.from(
        { length: 10 },
        (_, i) =>
          `Paragraph ${i} of the syndicated wire story describes the tower measurement in considerable detail for curious readers`,
      ).join(". ") + ". The tower is 330 meters tall today.";
    const first = makeDocument("source_1", "https://a.example.com/1", article);
    const second = makeDocument("source_2", "https://b.example.org/2", article);
    const input = {
      text: "The tower is 330 meters tall",
      quote: "330 meters tall",
      importance: "central" as const,
      agentId: "agent_1",
    };
    expect(ledger.addClaim(first, input).outcome).toBe("added");
    const result = ledger.addClaim(second, input);
    expect(result.outcome).toBe("duplicate");
    if (result.outcome !== "duplicate") throw new Error("unreachable");
    expect(result.representativeId).toBe("claim_1");
    expect(ledger.dupesDropped).toBe(1);
    expect(ledger.representatives()[0].corroboration).toBeUndefined();
  });

  it("keeps corroboration for distinct articles on different hosts", () => {
    const ledger = makeLedger();
    const sentence = "The tower is 330 meters tall today";
    const articleA =
      Array.from(
        { length: 10 },
        (_, i) =>
          `Original reporting paragraph ${i} covers the construction history of the tower with extensive archival quotations`,
      ).join(". ") + `. ${sentence}.`;
    const articleB =
      Array.from(
        { length: 10 },
        (_, i) =>
          `Independent analysis paragraph ${i} examines the measurement methodology behind the tower height figure in depth`,
      ).join(". ") + `. ${sentence}.`;
    const first = makeDocument("source_1", "https://a.example.com/1", articleA);
    const second = makeDocument("source_2", "https://b.example.org/2", articleB);
    const input = {
      text: "The tower is 330 meters tall",
      quote: "330 meters tall",
      importance: "central" as const,
      agentId: "agent_1",
    };
    expect(ledger.addClaim(first, input).outcome).toBe("added");
    expect(ledger.addClaim(second, input).outcome).toBe("corroborated");
    expect(ledger.representatives()[0].corroboration).toBe(2);
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

describe("ledger merge", () => {
  async function seeded(): Promise<Ledger> {
    const ledger = makeLedger();
    ledger.queue(
      makeDocument(
        "source_1",
        "https://a.example.com/1",
        "The tower is 330 meters tall today.",
      ),
      {
        goal: "g",
        agentId: "agent_1",
        model: extractionModel([
          {
            claim: "The tower is 330 meters tall",
            quote: "330 meters tall",
            importance: "central",
          },
        ]),
      },
    );
    await ledger.settle();
    ledger.queue(
      makeDocument(
        "source_2",
        "https://b.example.org/2",
        "The tower stands 330 meters high above the city.",
      ),
      {
        goal: "g",
        agentId: "agent_2",
        model: extractionModel([
          {
            claim: "The tower stands 330 meters high",
            quote: "stands 330 meters high",
            importance: "central",
          },
        ]),
      },
    );
    await ledger.settle();
    return ledger;
  }

  it("merges cross-host claims as corroboration and moves votes", async () => {
    const ledger = await seeded();
    const dup = ledger.claims[1];
    dup.votes = [
      { lens: "contradiction", refuted: false, evidence: "e", confidence: "high" },
      { lens: "quote-fidelity", refuted: false, evidence: "e", confidence: "high" },
    ];
    dup.status = "confirmed";
    expect(ledger.merge("claim_2", "claim_1")).toBe(true);
    const representatives = ledger.representatives();
    expect(representatives).toHaveLength(1);
    expect(representatives[0].id).toBe("claim_1");
    expect(representatives[0].corroboration).toBe(2);
    expect(representatives[0].votes).toHaveLength(2);
    expect(representatives[0].status).toBe("confirmed");
    expect(ledger.byId("claim_2")?.duplicateOf).toBe("claim_1");
  });

  it("counts same-host merges as dropped duplicates", async () => {
    const ledger = makeLedger();
    const queueOne = (sourceId: string, path: string, text: string, claim: string, quote: string) =>
      ledger.queue(makeDocument(sourceId, `https://a.example.com/${path}`, text), {
        goal: "g",
        agentId: "agent_1",
        model: extractionModel([{ claim, quote, importance: "central" }]),
      });
    queueOne(
      "source_1",
      "1",
      "The tower is 330 meters tall today.",
      "The tower is 330 meters tall",
      "330 meters tall",
    );
    await ledger.settle();
    queueOne(
      "source_2",
      "2",
      "The tower stands 330 meters high above the city.",
      "The tower stands 330 meters high",
      "stands 330 meters high",
    );
    await ledger.settle();
    expect(ledger.merge("claim_2", "claim_1")).toBe(true);
    expect(ledger.dupesDropped).toBe(1);
    expect(ledger.representatives()[0].corroboration).toBeUndefined();
  });

  it("refuses merges into itself or onto merged claims", async () => {
    const ledger = await seeded();
    expect(ledger.merge("claim_1", "claim_1")).toBe(false);
    expect(ledger.merge("claim_2", "claim_1")).toBe(true);
    expect(ledger.merge("claim_2", "claim_1")).toBe(false);
  });
});

describe("ledger extraction window", () => {
  it("truncates extraction input at the configured window", async () => {
    let prompt = "";
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompt = JSON.stringify(options.prompt);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sourceQuality: "secondary", claims: [] }),
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
    const ledger = createLedger({
      emit: () => {},
      signal: undefined,
      shouldExtract: () => true,
      extractionChars: 260,
    });
    ledger.queue(
      makeDocument(
        "source_1",
        "https://a.example.com/1",
        "The tower is 330 meters tall. ".repeat(20),
      ),
      { goal: "g", agentId: "agent_1", model },
    );
    await ledger.settle();
    expect(prompt).toContain("Source is 600 characters; showing the 260");
  });
});

describe("ledger addClaim", () => {
  it("admits a verbatim-quoted claim and fires events", () => {
    const events: string[] = [];
    const seen: string[] = [];
    const ledger = createLedger({
      emit: (event) => events.push(event.type),
      signal: undefined,
      shouldExtract: () => true,
      onClaim: (claim) => seen.push(claim.id),
    });
    const document = makeDocument(
      "source_1",
      "https://a.example.com/page",
      "The tower is 330 meters tall and was built in 1889.",
    );
    const result = ledger.addClaim(document, {
      text: "The tower was built in 1889",
      quote: "built in 1889",
      importance: "central",
      agentId: "agent_1",
    });
    expect(result.outcome).toBe("added");
    if (result.outcome !== "added") throw new Error("unreachable");
    expect(result.claim.id).toBe("claim_1");
    expect(result.claim.status).toBe("unverified");
    expect(result.claim.sourceQuality).toBe("secondary");
    expect(result.claim.agentId).toBe("agent_1");
    expect(events).toContain("claim.extracted");
    expect(seen).toEqual(["claim_1"]);
  });

  it("rejects quotes that are not verbatim in the source", () => {
    const ledger = makeLedger();
    const document = makeDocument(
      "source_1",
      "https://a.example.com/page",
      "The tower is 330 meters tall.",
    );
    const result = ledger.addClaim(document, {
      text: "The tower is about 330m",
      quote: "approximately 330m in height",
      importance: "supporting",
      agentId: "agent_1",
    });
    expect(result.outcome).toBe("unsupported");
    expect(ledger.unsupportedCount).toBe(1);
    expect(ledger.claims).toHaveLength(0);
  });

  it("records cross-host duplicates as corroboration", () => {
    const ledger = makeLedger();
    const text = "The tower is 330 meters tall today.";
    const first = makeDocument("source_1", "https://a.example.com/1", text);
    const second = makeDocument("source_2", "https://b.example.org/2", text);
    const input = {
      text: "The tower is 330 meters tall",
      quote: "330 meters tall",
      importance: "central" as const,
      agentId: "agent_1",
    };
    const added = ledger.addClaim(first, input);
    expect(added.outcome).toBe("added");
    const result = ledger.addClaim(second, input);
    expect(result.outcome).toBe("corroborated");
    if (result.outcome !== "corroborated") throw new Error("unreachable");
    expect(result.representativeId).toBe("claim_1");
    expect(ledger.representatives()[0].corroboration).toBe(2);
  });

  it("drops same-host duplicates and names the representative", () => {
    const ledger = makeLedger();
    const text = "The tower is 330 meters tall today.";
    const first = makeDocument("source_1", "https://a.example.com/1", text);
    const second = makeDocument("source_2", "https://a.example.com/2", text);
    const input = {
      text: "The tower is 330 meters tall",
      quote: "330 meters tall",
      importance: "central" as const,
      agentId: "agent_1",
    };
    ledger.addClaim(first, input);
    const result = ledger.addClaim(second, input);
    expect(result.outcome).toBe("duplicate");
    if (result.outcome !== "duplicate") throw new Error("unreachable");
    expect(result.representativeId).toBe("claim_1");
    expect(ledger.dupesDropped).toBe(1);
  });

  it("inherits source quality from sibling extracted claims", async () => {
    const ledger = makeLedger();
    const document = makeDocument(
      "source_1",
      "https://a.example.com/page",
      "The tower is 330 meters tall and was built in 1889.",
    );
    ledger.queue(document, {
      goal: "tower facts",
      agentId: "agent_1",
      model: extractionModel(
        [
          {
            claim: "The tower is 330 meters tall",
            quote: "330 meters tall",
            importance: "central",
          },
        ],
        "primary",
      ),
    });
    await ledger.settle();
    const result = ledger.addClaim(document, {
      text: "The tower was built in 1889",
      quote: "built in 1889",
      importance: "supporting",
      agentId: "agent_1",
    });
    expect(result.outcome).toBe("added");
    if (result.outcome !== "added") throw new Error("unreachable");
    expect(result.claim.sourceQuality).toBe("primary");
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
