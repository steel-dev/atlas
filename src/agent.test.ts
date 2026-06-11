import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.js";
import type { ResolvedModel } from "./model.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { SearchProvider } from "./providers/search.js";
import type { ResearchEvent } from "./events.js";

const USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function toolCallResult(
  toolName: string,
  input: unknown,
  text?: string,
): LanguageModelV3GenerateResult {
  return {
    content: [
      ...(text ? [{ type: "text", text } as const] : []),
      {
        type: "tool-call",
        toolCallId: `call_${toolName}_${Math.floor(Math.random() * 1e6)}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function promptText(options: LanguageModelV3CallOptions): string {
  return JSON.stringify(options.prompt);
}

function leadModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "lead-model",
    doGenerate: async () => {
      step++;
      if (step === 1) {
        return toolCallResult(
          "spawn",
          {
            role: "research",
            task: "Establish the tower's height. Original question: how tall is the tower?",
          },
          "Plan: spawn one research subagent on the tower's height.",
        );
      }
      if (step === 2) {
        return toolCallResult("spawn", {
          role: "verify",
          claim_ids: ["claim_1"],
          task: "Verify the height claim.",
        });
      }
      return textResult(
        "The ledger covers the height with a verified claim; stopping.",
      );
    },
  });
}

function leadModelNoVerify(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "lead-model",
    doGenerate: async () => {
      step++;
      if (step === 1) {
        return toolCallResult(
          "spawn",
          {
            role: "research",
            task: "Establish the tower's height. Original question: how tall is the tower?",
          },
          "Plan: spawn one research subagent on the tower's height.",
        );
      }
      return textResult("I have the claim but I'm stopping without verifying.");
    },
  });
}

function inlineLeadModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "lead-model",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      step++;
      if (step === 1) {
        return toolCallResult(
          "fetch",
          { url: "https://data.example.com/tower" },
          "Plan: fetch the official register inline, then verify the claim.",
        );
      }
      if (step === 2) {
        return toolCallResult("ledger", {});
      }
      if (step === 3) {
        if (!promptText(options).includes("claim_1")) {
          return textResult("Ledger digest did not surface my claim.");
        }
        return toolCallResult("spawn", {
          role: "verify",
          claim_ids: ["claim_1"],
          task: "Verify the height claim.",
        });
      }
      return textResult("Verified inline; stopping.");
    },
  });
}

function researchModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "research-model",
    doGenerate: async () => {
      step++;
      if (step === 1) {
        return toolCallResult("fetch", {
          url: "https://data.example.com/tower",
        });
      }
      return textResult("Found the height in an official source.");
    },
  });
}

function extractModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "extract-model",
    doGenerate: async () =>
      textResult(
        JSON.stringify({
          sourceQuality: "primary",
          claims: [
            {
              claim: "The tower is 330 meters tall",
              quote: "330 meters tall",
              importance: "central",
            },
          ],
        }),
      ),
  });
}

function verifyModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "verify-model",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        if (promptText(options).includes("Return your verdict")) {
          return textResult(
            JSON.stringify({
              refuted: false,
              evidence: "The official page states the height plainly.",
              confidence: "high",
            }),
          );
        }
        return textResult(JSON.stringify({ openQuestions: [] }));
      }
      return textResult("Checked the claim through my lens; it holds.");
    },
  });
}

function writeModel(): ResolvedModel {
  return wrapLanguageModel({
    model: new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "write-model",
      doGenerate: async () =>
        textResult("The tower is 330 meters tall. {{claim_1}}"),
    }),
    middleware: simulateStreamingMiddleware(),
  }) as unknown as ResolvedModel;
}

const stubSearch: SearchProvider = {
  id: "stub",
  search: async () => [
    {
      position: 1,
      title: "Tower",
      url: "https://data.example.com/tower",
      snippet: "330 meters",
      domain: "data.example.com",
    },
  ],
};

const stubFetch: FetchProvider = {
  id: "stub",
  fetch: async ({ url }) => {
    const markdown =
      "The famous tower stands at 330 meters tall as of the latest renovation, according to the official register of monuments and structures maintained by the city since 1889.".padEnd(
        320,
        " more official text",
      );
    return {
      ok: true,
      attempt: { method: "stub", ok: true, note: "stub fetch" },
      page: {
        finalUrl: url,
        title: "Official tower register",
        markdown,
        renderedWith: "stub",
        metadata: { markdownChars: markdown.length, extractionNotes: [] },
      },
    };
  },
};

describe("emergent multi-agent run", () => {
  it("spawns research and verify subagents, settles the claim, and binds the citation", async () => {
    const atlas = new Atlas({
      model: leadModel() as unknown as ResolvedModel,
      models: {
        research: researchModel() as unknown as ResolvedModel,
        extract: extractModel() as unknown as ResolvedModel,
        verify: verifyModel() as unknown as ResolvedModel,
        write: writeModel() as unknown as ResolvedModel,
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("how tall is the tower?", {
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(result.claims.confirmed).toHaveLength(1);
    expect(result.claims.confirmed[0].id).toBe("claim_1");
    expect(result.claims.confirmed[0].votes).toHaveLength(3);
    expect(result.claims.confirmed[0].status).toBe("confirmed");

    expect(result.report).toBe("The tower is 330 meters tall.");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].verified).toBe(true);
    expect(result.citations[0].claimId).toBe("claim_1");

    expect(result.stats.singleAgent).toBe(false);
    expect(result.stats.agentsSpawned).toBe(4);
    expect(result.stats.maxDepth).toBe(1);
    expect(result.stats.sourcesFetched).toBe(1);
    expect(result.stats.claimsVerified).toBe(1);
    expect(result.stats.claimsConfirmed).toBe(1);

    const types = events.map((event) => event.type);
    expect(types).toContain("agent.spawned");
    expect(types).toContain("agent.returned");
    expect(types).toContain("claim.extracted");
    expect(types).toContain("claim.verified");
    expect(types).toContain("citation.bound");
    expect(types).toContain("pricing.missing");
    expect(types).not.toContain("safety.flag");
    expect(
      types.filter((type) => type === "report.delta").length,
    ).toBeGreaterThan(0);

    const spawned = events.filter(
      (event): event is Extract<ResearchEvent, { type: "agent.spawned" }> =>
        event.type === "agent.spawned",
    );
    expect(spawned.filter((event) => event.role === "research")).toHaveLength(
      1,
    );
    expect(spawned.filter((event) => event.role === "verify")).toHaveLength(3);
  });

  it("lets an inline lead read the ledger and verify its own claims", async () => {
    const atlas = new Atlas({
      model: inlineLeadModel() as unknown as ResolvedModel,
      models: {
        extract: extractModel() as unknown as ResolvedModel,
        verify: verifyModel() as unknown as ResolvedModel,
        write: writeModel() as unknown as ResolvedModel,
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("how tall is the tower?", {
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(result.claims.confirmed).toHaveLength(1);
    expect(result.claims.confirmed[0].id).toBe("claim_1");
    expect(result.stats.claimsVerified).toBe(1);

    const spawned = events.filter(
      (event): event is Extract<ResearchEvent, { type: "agent.spawned" }> =>
        event.type === "agent.spawned",
    );
    expect(spawned.filter((event) => event.role === "research")).toHaveLength(
      0,
    );
    expect(spawned.filter((event) => event.role === "verify")).toHaveLength(3);
  });

  it("force-verifies claims the lead never checked, from the reserve", async () => {
    const atlas = new Atlas({
      model: leadModelNoVerify() as unknown as ResolvedModel,
      models: {
        research: researchModel() as unknown as ResolvedModel,
        extract: extractModel() as unknown as ResolvedModel,
        verify: verifyModel() as unknown as ResolvedModel,
        write: writeModel() as unknown as ResolvedModel,
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("how tall is the tower?", {
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(result.claims.confirmed).toHaveLength(1);
    expect(result.claims.confirmed[0].id).toBe("claim_1");
    expect(result.stats.claimsConfirmed).toBe(1);
    expect(events.map((event) => event.type)).toContain("claim.verified");

    const spawned = events.filter(
      (event): event is Extract<ResearchEvent, { type: "agent.spawned" }> =>
        event.type === "agent.spawned",
    );
    expect(spawned.filter((event) => event.role === "research")).toHaveLength(
      1,
    );
    expect(spawned.filter((event) => event.role === "verify")).toHaveLength(3);
  });
});

describe("durable resume", () => {
  const ZERO_USAGE = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };

  function zeroText(text: string): LanguageModelV3GenerateResult {
    return {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    };
  }

  function zeroToolCall(
    toolName: string,
    input: unknown,
    id: string,
  ): LanguageModelV3GenerateResult {
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: id,
          toolName,
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    };
  }

  function resumeLead(): MockLanguageModelV3 {
    let step = 0;
    return new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "lead-model",
      doGenerate: async () => {
        step++;
        if (step === 1) {
          return zeroToolCall(
            "search",
            { queries: ["tower height"] },
            "call_search_1",
          );
        }
        if (step === 2) {
          return zeroToolCall(
            "fetch",
            { url: "https://data.example.com/tower" },
            "call_fetch_1",
          );
        }
        return zeroText("The ledger covers the height; stopping.");
      },
    });
  }

  function resumeExtract(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "extract-model",
      doGenerate: async () =>
        zeroText(
          JSON.stringify({
            sourceQuality: "primary",
            claims: [
              {
                claim: "The tower is 330 meters tall",
                quote: "330 meters tall",
                importance: "central",
              },
            ],
          }),
        ),
    });
  }

  function resumeVerify(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "verify-model",
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        if (options.responseFormat?.type === "json") {
          if (promptText(options).includes("Return your verdict")) {
            return zeroText(
              JSON.stringify({
                refuted: false,
                evidence: "The page states the height plainly.",
                confidence: "high",
              }),
            );
          }
          return zeroText(JSON.stringify({ openQuestions: [] }));
        }
        return zeroText("Checked the claim through my lens; it holds.");
      },
    });
  }

  function resumeWrite(): {
    model: ResolvedModel;
    inner: MockLanguageModelV3;
  } {
    const inner = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "write-model",
      doGenerate: async () =>
        zeroText("The tower is 330 meters tall. {{claim_1}}"),
    });
    return {
      model: wrapLanguageModel({
        model: inner,
        middleware: simulateStreamingMiddleware(),
      }) as unknown as ResolvedModel,
      inner,
    };
  }

  it("replays models, searches, and fetches entirely from the journal", async () => {
    const { memoryStore } = await import("./providers/store.js");
    const store = memoryStore();
    let liveFetches = 0;
    const countingFetch: FetchProvider = {
      id: "stub",
      fetch: async (req) => {
        liveFetches++;
        return stubFetch.fetch(req);
      },
    };

    const firstAtlas = new Atlas({
      model: resumeLead() as unknown as ResolvedModel,
      models: {
        extract: resumeExtract() as unknown as ResolvedModel,
        verify: resumeVerify() as unknown as ResolvedModel,
        write: resumeWrite().model,
      },
      search: stubSearch,
      fetch: countingFetch,
      store,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });
    const original = await firstAtlas
      .start("how tall is the tower?", {
        budget: { maxUSD: 5 },
        runId: "run_durable_resume",
      })
      .result();
    expect(liveFetches).toBe(1);
    expect(original.claims.confirmed).toHaveLength(1);
    expect(original.report).toBe("The tower is 330 meters tall.");

    const lead2 = resumeLead();
    const extract2 = resumeExtract();
    const verify2 = resumeVerify();
    const write2 = resumeWrite();
    const throwingFetch: FetchProvider = {
      id: "stub",
      fetch: async () => {
        throw new Error("live fetch during replay");
      },
    };
    const throwingSearch: SearchProvider = {
      id: "stub",
      search: async () => {
        throw new Error("live search during replay");
      },
    };
    const resumed = await Atlas.resume("run_durable_resume", {
      model: lead2 as unknown as ResolvedModel,
      models: {
        extract: extract2 as unknown as ResolvedModel,
        verify: verify2 as unknown as ResolvedModel,
        write: write2.model,
      },
      search: throwingSearch,
      fetch: throwingFetch,
      store,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });
    const replayed = await resumed.result();

    expect(replayed.report).toBe(original.report);
    expect(replayed.citations).toHaveLength(1);
    expect(replayed.citations[0].verified).toBe(true);
    expect(replayed.stats.sourcesFetched).toBe(1);
    expect(replayed.stats.claimsConfirmed).toBe(1);
    expect(lead2.doGenerateCalls).toHaveLength(0);
    expect(extract2.doGenerateCalls).toHaveLength(0);
    expect(verify2.doGenerateCalls).toHaveLength(0);
    expect(write2.inner.doGenerateCalls).toHaveLength(0);
    expect(write2.inner.doStreamCalls).toHaveLength(0);
    expect(replayed.stats.costUSD).toBe(0);
  });
});
