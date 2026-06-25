import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3ToolChoice,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.js";
import type { ResearchEvent } from "./events.js";
import type { ResolvedModel } from "./model.js";
import type { FetchProvider } from "./providers/fetch.js";
import type { SearchProvider } from "./providers/search.js";

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

function searchCallResult(): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "call_search_1",
        toolName: "search",
        input: JSON.stringify({ queries: ["paradoxical bronchospasm rescue inhaler"] }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

function planModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "lead-model",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      if (options.responseFormat?.type === "json") {
        return textResult(
          JSON.stringify({
            rationale: "Scope the safety question into sub-questions.",
            subQuestions: [
              "Can a rescue inhaler worsen wheezing?",
              "When should worsening symptoms prompt urgent care?",
            ],
          }),
        );
      }
      return textResult("planned");
    },
  });
}

function gatherModel(
  seenToolChoices: (LanguageModelV3ToolChoice | undefined)[],
): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "research-model",
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      seenToolChoices.push(options.toolChoice);
      step++;
      if (step === 1) return searchCallResult();
      return textResult("Closing note: surveyed the question from fetched sources.");
    },
  });
}

function jsonModel(modelId: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId,
    doGenerate: async () => textResult(JSON.stringify({ claims: [] })),
  });
}

function writeModel(): ResolvedModel {
  return wrapLanguageModel({
    model: new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "write-model",
      doGenerate: async () => textResult("A grounded answer."),
    }),
    middleware: simulateStreamingMiddleware(),
  }) as unknown as ResolvedModel;
}

const stubFetch: FetchProvider = {
  id: "stub",
  fetch: async ({ url }) => {
    const markdown =
      "Paradoxical bronchospasm is a recognized adverse reaction to inhaled bronchodilators, in which the rescue inhaler worsens wheezing instead of relieving it.".padEnd(
        320,
        " more clinical text",
      );
    return {
      ok: true,
      attempt: { method: "stub", ok: true, note: "stub fetch" },
      page: {
        finalUrl: url,
        title: "Paradoxical bronchospasm",
        markdown,
        renderedWith: "stub",
        metadata: { markdownChars: markdown.length, extractionNotes: [] },
      },
    };
  },
};

describe("spine engagement", () => {
  it("forces the gather phase to search before it can answer from memory", async () => {
    const seenToolChoices: (LanguageModelV3ToolChoice | undefined)[] = [];
    let searched = false;
    const trackingSearch: SearchProvider = {
      id: "stub",
      search: async () => {
        searched = true;
        return [
          {
            position: 1,
            title: "Paradoxical bronchospasm",
            url: "https://medline.example.com/bronchospasm",
            snippet: "rescue inhaler worsening wheezing",
            domain: "medline.example.com",
          },
        ];
      },
    };

    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: gatherModel(seenToolChoices) as unknown as ResolvedModel,
        extract: jsonModel("extract-model") as unknown as ResolvedModel,
        write: writeModel(),
      },
      search: trackingSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start(
      "my new blue rescue inhaler made my wheezing worse, O2 dipping to 91 — stop or just adjusting?",
      { budget: { maxUSD: 5 } },
    );
    await run.result();

    expect(seenToolChoices.length).toBeGreaterThanOrEqual(1);
    expect(seenToolChoices[0]).toEqual({ type: "tool", toolName: "search" });
    expect(searched).toBe(true);
  });
});

describe("gather failure visibility", () => {
  it("surfaces a non-abort gather model error instead of swallowing it", async () => {
    // Mirrors an unreachable research/gather model endpoint, such as "Invalid
    // JSON response" through a mismatched proxy.
    const failingResearchModel = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "research-model",
      doGenerate: async () => {
        throw Object.assign(new Error("Invalid JSON response"), {
          isRetryable: false,
        });
      },
    });

    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: failingResearchModel as unknown as ResolvedModel,
        extract: jsonModel("extract-model") as unknown as ResolvedModel,
        write: writeModel(),
      },
      search: { id: "stub", search: async () => [] },
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("test question", {
      runId: "run_gather_fail",
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(run.status()).toBe("completed");
    expect(result.report).toMatch(/Research failed before any sources/i);
    expect(result.note).toMatch(/Invalid JSON response/i);
    expect(result.failure).toEqual({
      phase: "gather",
      message:
        "Research failed before any sources could be retrieved: Invalid JSON response",
    });
    const runErrors = events.filter(
      (event): event is Extract<ResearchEvent, { type: "run.error" }> =>
        event.type === "run.error",
    );
    expect(
      runErrors.some(
        (event) => event.recoverable && /gather failed/i.test(event.message),
      ),
    ).toBe(true);
  });
});

function fetchCallResult(): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "call_fetch_1",
        toolName: "fetch",
        input: JSON.stringify({ urls: ["https://example.com/answer"] }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: USAGE,
    warnings: [],
  };
}

// A gather model that searches, then fetches a source (so the run reaches the
// post-gather synthesis phase), then writes a closing note.
function gatherModelFetching(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "research-model",
    doGenerate: async () => {
      step++;
      if (step === 1) return searchCallResult();
      if (step === 2) return fetchCallResult();
      return textResult("Closing note: surveyed the question from fetched sources.");
    },
  });
}

function failingWriteModel(message: string): ResolvedModel {
  return wrapLanguageModel({
    model: new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "write-model",
      doGenerate: async () => {
        throw Object.assign(new Error(message), { isRetryable: false });
      },
    }),
    middleware: simulateStreamingMiddleware(),
  }) as unknown as ResolvedModel;
}

describe("post-gather failure visibility", () => {
  it("emits a recoverable run.error when synthesis fails instead of swallowing it", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: gatherModelFetching() as unknown as ResolvedModel,
        extract: jsonModel("extract-model") as unknown as ResolvedModel,
        write: failingWriteModel("synthesis endpoint down"),
      },
      search: {
        id: "stub",
        search: async () => [
          {
            position: 1,
            title: "Answer",
            url: "https://example.com/answer",
            snippet: "snippet",
            domain: "example.com",
          },
        ],
      },
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("test question", {
      runId: "run_synth_fail",
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    // Sanity: gather fetched a source, so the run reached the post-gather path.
    expect(result.sources.length).toBeGreaterThan(0);
    expect(run.status()).toBe("completed");
    expect(result.report).toMatch(/surveyed the question from fetched sources/i);
    expect(result.note).toMatch(/synthesis endpoint down/i);
    expect(result.note).toMatch(/surveyed the question from fetched sources/i);
    expect(result.failure).toEqual({
      phase: "synthesis",
      message: "Synthesis failed: synthesis endpoint down",
    });
    const runErrors = events.filter(
      (event): event is Extract<ResearchEvent, { type: "run.error" }> =>
        event.type === "run.error",
    );
    expect(
      runErrors.some(
        (event) => event.recoverable && /synthesis failed/i.test(event.message),
      ),
    ).toBe(true);
  });
});
