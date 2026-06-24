import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3ToolChoice,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.js";
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
