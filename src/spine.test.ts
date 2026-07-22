import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3ToolChoice,
} from "@ai-sdk/provider";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
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
        input: JSON.stringify({
          queries: ["paradoxical bronchospasm rescue inhaler"],
        }),
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
      return textResult(
        "Closing note: surveyed the question from fetched sources.",
      );
    },
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

function fetchingGatherModel(): ResolvedModel {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "research-model",
    doGenerate: async () => {
      step++;
      if (step === 1) return searchCallResult();
      if (step === 2) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "fetch_1",
              toolName: "fetch",
              input: JSON.stringify({
                url: "https://medline.example.com/bronchospasm",
                goal: "paradoxical bronchospasm",
              }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      return textResult(
        "Closing note: the rescue inhaler can worsen wheezing.",
      );
    },
  }) as unknown as ResolvedModel;
}

function draftingWriteModel(): ResolvedModel {
  let drafted = false;
  return wrapLanguageModel({
    model: new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "write-model",
      doGenerate: async () => {
        if (!drafted) {
          drafted = true;
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "draft_1",
                toolName: "draft_set",
                input: JSON.stringify({
                  markdown:
                    "A rescue inhaler can cause paradoxical bronchospasm, worsening wheezing [source_1].",
                }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: USAGE,
            warnings: [],
          };
        }
        return textResult("Report complete.");
      },
    }),
    middleware: simulateStreamingMiddleware(),
  }) as unknown as ResolvedModel;
}

const stubSearch: SearchProvider = {
  id: "stub",
  search: async () => [
    {
      position: 1,
      title: "Paradoxical bronchospasm",
      url: "https://medline.example.com/bronchospasm",
      snippet: "rescue inhaler worsening wheezing",
      domain: "medline.example.com",
    },
  ],
};

function budgetAtlas(
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>,
): Atlas {
  return new Atlas({
    model: planModel() as unknown as ResolvedModel,
    models: { research: fetchingGatherModel(), write: draftingWriteModel() },
    search: stubSearch,
    fetch: stubFetch,
    effort: "fast",
    pricing,
    safety: { allowPrivateNetworks: true },
  });
}

describe("spine budget control", () => {
  it("reserves the draft pass and produces a report at a low feasible budget", async () => {
    const atlas = budgetAtlas({
      "lead-model": { inputPerMTok: 1, outputPerMTok: 5 },
      "research-model": { inputPerMTok: 1, outputPerMTok: 5 },
      "write-model": { inputPerMTok: 1, outputPerMTok: 5 },
    });
    const result = await atlas
      .start("can my rescue inhaler make wheezing worse?", {
        budget: { maxUSD: 0.5 },
      })
      .result();
    expect(result.report).toContain("paradoxical bronchospasm");
    expect(result.report).not.toContain("no report could be composed");
  });

  it("rejects an infeasible budget with an actionable error", async () => {
    const atlas = budgetAtlas({
      "lead-model": { inputPerMTok: 50, outputPerMTok: 200 },
      "research-model": { inputPerMTok: 50, outputPerMTok: 200 },
      "write-model": { inputPerMTok: 50, outputPerMTok: 200 },
    });
    await expect(
      atlas
        .start("can my rescue inhaler make wheezing worse?", {
          budget: { maxUSD: 0.1 },
        })
        .result(),
    ).rejects.toThrow(/budget/i);
  });
});

function recoverableRunErrors(
  events: ResearchEvent[],
): Extract<ResearchEvent, { type: "run.error" }>[] {
  return events.filter(
    (event): event is Extract<ResearchEvent, { type: "run.error" }> =>
      event.type === "run.error" && event.recoverable,
  );
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

// Gathers cleanly (searches, finds nothing to fetch) so the run reaches the
// zero-source fallback with no captured error — a benign degenerate result.
function emptyGatherModel(): ResolvedModel {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "research-model",
    doGenerate: async () => {
      step++;
      if (step === 1) return searchCallResult();
      return textResult("Closing note: no usable sources were found.");
    },
  }) as unknown as ResolvedModel;
}

// Never calls draft_set, so synthesis completes without error but leaves the
// draft empty — the budget-exhaustion-shaped empty-draft fallback.
function nonDraftingWriteModel(): ResolvedModel {
  return wrapLanguageModel({
    model: new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "write-model",
      doGenerate: async () => textResult("No draft written."),
    }),
    middleware: simulateStreamingMiddleware(),
  }) as unknown as ResolvedModel;
}

describe("spine failure visibility", () => {
  it("surfaces a non-abort gather model outage instead of swallowing it", async () => {
    // Mirrors an unreachable research/gather model endpoint, such as an
    // "Invalid JSON response" through a mismatched proxy base URL.
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
    expect(
      recoverableRunErrors(events).some((event) =>
        /gather failed/i.test(event.message),
      ),
    ).toBe(true);
  });

  it("surfaces a non-abort synthesis outage instead of swallowing it", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: fetchingGatherModel(),
        write: failingWriteModel("synthesis endpoint down"),
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("can my rescue inhaler make wheezing worse?", {
      runId: "run_synth_fail",
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    // Sanity: gather fetched a source, so the run reached the synthesis phase.
    expect(result.sources.length).toBeGreaterThan(0);
    expect(run.status()).toBe("completed");
    expect(result.note).toMatch(/synthesis endpoint down/i);
    expect(
      recoverableRunErrors(events).some((event) =>
        /synthesis failed/i.test(event.message),
      ),
    ).toBe(true);
  });

  it("re-throws on abort without emitting a recoverable run.error", async () => {
    const controller = new AbortController();
    const abortingResearchModel = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "research-model",
      doGenerate: async () => {
        controller.abort();
        throw Object.assign(new Error("aborted mid-flight"), {
          isRetryable: false,
        });
      },
    });

    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: abortingResearchModel as unknown as ResolvedModel,
        write: writeModel(),
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("test question", {
      runId: "run_abort",
      budget: { maxUSD: 5 },
      signal: controller.signal,
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    await expect(run.result()).rejects.toThrow();
    await drain;

    expect(run.status()).toBe("aborted");
    expect(recoverableRunErrors(events)).toHaveLength(0);
  });

  it("leaves a healthy run free of recoverable run.error events", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: { research: fetchingGatherModel(), write: draftingWriteModel() },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const run = atlas.start("can my rescue inhaler make wheezing worse?", {
      runId: "run_healthy",
      budget: { maxUSD: 5 },
    });
    const events: ResearchEvent[] = [];
    const drain = (async () => {
      for await (const event of run.events()) events.push(event);
    })();
    const result = await run.result();
    await drain;

    expect(run.status()).toBe("completed");
    expect(result.report).toContain("paradoxical bronchospasm");
    expect(recoverableRunErrors(events)).toHaveLength(0);
  });

  it("marks a total gather outage as a gather failure", async () => {
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
        write: writeModel(),
      },
      search: { id: "stub", search: async () => [] },
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const result = await atlas
      .start("test question", {
        runId: "run_gather_failure_flag",
        budget: { maxUSD: 5 },
      })
      .result();

    expect(result.failure).toBeDefined();
    expect(result.failure?.phase).toBe("gather");
    expect(result.failure?.message).toMatch(/Invalid JSON response/i);
    expect(result.degenerate).toBeUndefined();
  });

  it("marks a synthesis outage as a synthesis failure", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: fetchingGatherModel(),
        write: failingWriteModel("synthesis endpoint down"),
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const result = await atlas
      .start("can my rescue inhaler make wheezing worse?", {
        runId: "run_synth_failure_flag",
        budget: { maxUSD: 5 },
      })
      .result();

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.failure).toBeDefined();
    expect(result.failure?.phase).toBe("synthesis");
    expect(result.failure?.message).toMatch(/synthesis endpoint down/i);
    expect(result.degenerate).toBeUndefined();
  });

  it("marks a clean zero-source run as degenerate, not failed", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: { research: emptyGatherModel(), write: writeModel() },
      search: { id: "stub", search: async () => [] },
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const result = await atlas
      .start("a question nothing usable answers", {
        runId: "run_zero_source_degenerate",
        budget: { maxUSD: 5 },
      })
      .result();

    expect(result.sources.length).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.degenerate).toBeDefined();
    expect(result.degenerate?.reason).toMatch(/no sources retrieved/i);
  });

  it("marks a budget-exhausted empty draft as degenerate, not failed", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: {
        research: fetchingGatherModel(),
        write: nonDraftingWriteModel(),
      },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const result = await atlas
      .start("can my rescue inhaler make wheezing worse?", {
        runId: "run_empty_draft_degenerate",
        budget: { maxUSD: 5 },
      })
      .result();

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.failure).toBeUndefined();
    expect(result.degenerate).toBeDefined();
    expect(result.degenerate?.reason).toMatch(
      /no report composed within budget/i,
    );
  });

  it("leaves a healthy run free of failure and degenerate flags", async () => {
    const atlas = new Atlas({
      model: planModel() as unknown as ResolvedModel,
      models: { research: fetchingGatherModel(), write: draftingWriteModel() },
      search: stubSearch,
      fetch: stubFetch,
      effort: "fast",
      safety: { allowPrivateNetworks: true },
    });

    const result = await atlas
      .start("can my rescue inhaler make wheezing worse?", {
        runId: "run_healthy_flags",
        budget: { maxUSD: 5 },
      })
      .result();

    expect(result.report).toContain("paradoxical bronchospasm");
    expect(result.failure).toBeUndefined();
    expect(result.degenerate).toBeUndefined();
  });
});
