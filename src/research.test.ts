import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./research.js";
import {
  emptyUsageSummary,
  type ModelAdapter,
  type ModelAssistantBlock,
  type ModelStepInput,
} from "./model.js";
import {
  createAgentScope,
  createResearchCaches,
  createSourceReservations,
  type ResearchCtx,
} from "./runtime.js";
import type { SourceDocument } from "./sources.js";

function fakeModel(scriptedSteps: ModelAssistantBlock[][]): {
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
      const content =
        scriptedSteps[Math.min(index, scriptedSteps.length - 1)] ?? [];
      index++;
      return { content };
    },
  };
  return { adapter, calls };
}

function singleSourceContext(document: SourceDocument): ResearchCtx {
  const sourceDocuments = new Map<string, SourceDocument>([
    [document.canonicalUrl, document],
  ]);
  return { store: { sourceDocuments } } as unknown as ResearchCtx;
}

function followupResearchContext(model: ModelAdapter): ResearchCtx {
  return {
    config: { useProxy: false, sourceCap: 10 },
    deps: { model, abort: () => undefined },
    store: {
      fetchedSources: [],
      sourceDocuments: new Map(),
      sourceReservations: createSourceReservations(),
      caches: createResearchCaches(),
    },
    scope: createAgentScope({ sink: () => undefined }),
  } as unknown as ResearchCtx;
}

function sourceDocument(markdown: string): SourceDocument {
  return {
    sourceId: "source_1",
    url: "https://example.com/profile",
    canonicalUrl: "https://example.com/profile",
    title: "Profile",
    markdown,
    originalChars: markdown.length,
    storedChars: markdown.length,
    truncated: false,
    metadata: { markdownChars: markdown.length, extractionNotes: [] },
    chunks: [{ index: 0, start: 0, end: markdown.length }],
  };
}

describe("research source citations", () => {
  it("matches cited URLs with the same normalization used for fetched sources", () => {
    const citations = __testing.reconcileCitations(
      "Evidence from [Example](https://example.com/report?utm_source=newsletter&b=2&a=1#section).",
      [
        {
          url: "https://example.com/report?a=1&b=2",
          title: "Example Report",
        },
      ],
    );

    expect(citations.citedSources).toEqual([
      {
        url: "https://example.com/report?a=1&b=2",
        title: "Example Report",
      },
    ]);
    expect(citations.citationsNotFetched).toEqual([]);
  });

  it("does not promote unfetched cited URLs into cited sources", () => {
    const citations = __testing.reconcileCitations(
      [
        "Cited evidence from [Fetched](https://example.com/fetched).",
        "Claim citing an unread page [Unfetched](https://example.com/unfetched).",
        "Repeated bare URL should dedupe: https://example.com/unfetched.",
      ].join("\n"),
      [
        {
          url: "https://example.com/fetched",
          title: "Fetched Source",
        },
      ],
    );

    expect(citations.citedSources).toEqual([
      {
        url: "https://example.com/fetched",
        title: "Fetched Source",
      },
    ]);
    expect(citations.citationsNotFetched).toEqual([
      "https://example.com/unfetched",
    ]);
  });

  it("preserves balanced parentheses in cited URLs", () => {
    const citations = __testing.reconcileCitations(
      [
        "From [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and a bare",
        "https://en.wikipedia.org/wiki/Baz_(qux).",
      ].join(" "),
      [
        { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" },
        { url: "https://en.wikipedia.org/wiki/Baz_(qux)", title: "Baz" },
      ],
    );

    expect(citations.citedSources).toEqual([
      { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" },
      { url: "https://en.wikipedia.org/wiki/Baz_(qux)", title: "Baz" },
    ]);
    expect(citations.citationsNotFetched).toEqual([]);
  });
});

describe("structured output finalization", () => {
  const output = {
    name: "test_output",
    schema: {
      type: "object",
      properties: {
        final_answer: { type: "string" },
        evidence: { type: "array", items: { type: "object" } },
      },
      required: ["final_answer", "evidence"],
      additionalProperties: false,
    },
  };

  it("keeps source tools and a follow-up research request available while finalizing", async () => {
    const ctx = singleSourceContext(
      sourceDocument("Nicholas Munene Mutuma is a Kenyan actor."),
    );
    const { adapter, calls } = fakeModel([
      [
        {
          type: "text",
          text: JSON.stringify({ final_answer: "ok", evidence: [] }),
        },
      ],
    ]);

    await __testing.generateStructuredOutput({
      ctx,
      model: adapter,
      messages: [{ role: "user", content: "transcript" }],
      output,
      maxTokens: 1024,
      effort: "low",
    });

    const toolNames = (calls[0]?.tools ?? []).map((tool) => tool.name).sort();
    expect(toolNames).toEqual([
      "read_source",
      "request_more_research",
      "search_sources",
    ]);
  });

  it("runs one focused research pass when finalization requests missing evidence", async () => {
    const { adapter, calls } = fakeModel([
      [
        {
          type: "tool_call",
          id: "more_1",
          name: "request_more_research",
          input: { question: "Find the missing date." },
        },
      ],
      [
        {
          type: "text",
          text: "# Extra Report\n\nMissing date is 2020.",
        },
      ],
      [
        {
          type: "text",
          text: JSON.stringify({ final_answer: "2020", evidence: [] }),
        },
      ],
    ]);
    const result = await __testing.generateStructuredOutputWithRuns({
      ctx: followupResearchContext(adapter),
      model: adapter,
      messages: [{ role: "user", content: "transcript" }],
      output,
      maxTokens: 1024,
      effort: "low",
    });

    expect(result.value).toEqual({ final_answer: "2020", evidence: [] });
    expect(result.additionalRuns).toEqual([
      {
        fetchedUrls: [],
        toolCalls: 0,
        finishReason: "structured follow-up: final report",
      },
    ]);
    expect(JSON.stringify(calls[1]?.messages)).toContain(
      "Find the missing date.",
    );
    expect(JSON.stringify(calls[2]?.messages)).toContain(
      "Missing date is 2020",
    );
  });

  it("executes a read_source quote call and returns the verified JSON", async () => {
    const markdown = "Nicholas Munene Mutuma is a Kenyan actor.";
    const ctx = singleSourceContext(sourceDocument(markdown));
    const { adapter, calls } = fakeModel([
      [
        {
          type: "tool_call",
          id: "call_1",
          name: "read_source",
          input: { source_id: "source_1", start: 0, end: 23 },
        },
      ],
      [
        {
          type: "text",
          text: JSON.stringify({
            final_answer: "Nicholas Munene Mutuma",
            evidence: [
              {
                source_id: "source_1",
                quote: "Nicholas Munene Mutuma",
              },
            ],
          }),
        },
      ],
    ]);

    const result = await __testing.generateStructuredOutput({
      ctx,
      model: adapter,
      messages: [{ role: "user", content: "transcript" }],
      output,
      maxTokens: 1024,
      effort: "low",
    });

    expect(result).toEqual({
      final_answer: "Nicholas Munene Mutuma",
      evidence: [{ source_id: "source_1", quote: "Nicholas Munene Mutuma" }],
    });
    expect(JSON.stringify(calls[1]?.messages)).toContain(
      "Nicholas Munene Mutuma",
    );
  });
});

describe("resolveRunConfig", () => {
  const ATLAS_ENV_KEYS = [
    "ATLAS_TOKEN_LIMIT",
    "ATLAS_TEAM_SIZE",
    "ATLAS_MAX_SUBAGENTS",
    "ATLAS_MAX_CONCURRENT_MODEL_CALLS",
    "ATLAS_MAX_DELEGATION_DEPTH",
    "ATLAS_THINKING_EFFORT",
    "ATLAS_COMPACTION_TRIGGER_TOKENS",
    "ATLAS_COMPACTION_KEEP_TOKENS",
    "ATLAS_SUMMARY_MODEL",
    "ATLAS_SEARCH_PROVIDER",
    "ATLAS_EXA_API_KEY",
    "EXA_API_KEY",
    "ATLAS_BRAVE_API_KEY",
    "BRAVE_API_KEY",
    "ATLAS_BROWSER_MAX_SESSIONS",
    "ATLAS_BROWSER_IDLE_TTL_MS",
  ];

  function clearAtlasEnv(): void {
    for (const key of ATLAS_ENV_KEYS) vi.stubEnv(key, "");
  }

  afterEach(() => vi.unstubAllEnvs());

  it("derives tool-call and source caps from the token budget", () => {
    clearAtlasEnv();
    const config = __testing.resolveRunConfig({
      query: "q",
      provider: "anthropic",
      model: "m",
      steelApiKey: "sk",
      tokenLimit: 800_000,
      suggestedTeamSize: 50,
    });

    expect(config.agent.tokenLimit).toBe(800_000);
    expect(config.safetyMaxToolCalls).toBe(100);
    expect(config.agent.sourceCap).toBe(80);
    expect(config.suggestedTeamSize).toBe(8);
    expect(config.agent.maxConcurrentSubagents).toBe(8);
    expect(config.maxConcurrentModelCalls).toBe(9);
    expect(config.summaryModel).toBe("claude-haiku-4-6");
    expect(config.timeoutDeadlineAt).toBeUndefined();
  });

  it("sizes caps from the default budget when tokens are unlimited", () => {
    clearAtlasEnv();
    const config = __testing.resolveRunConfig({
      query: "q",
      provider: "anthropic",
      model: "m",
      steelApiKey: "sk",
      tokenLimit: 0,
    });

    expect(config.agent.tokenLimit).toBe(0);
    expect(config.safetyMaxToolCalls).toBe(250);
    expect(config.agent.sourceCap).toBe(100);
  });

  it("reserves finalization time from the wall-clock timeout", () => {
    clearAtlasEnv();
    const before = Date.now();
    const config = __testing.resolveRunConfig({
      query: "q",
      provider: "anthropic",
      model: "m",
      steelApiKey: "sk",
      timeoutMs: 60_000,
    });

    expect(config.synthesisReserveMs).toBe(15_000);
    expect(config.timeoutDeadlineAt ?? 0).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("requires a Steel API key", () => {
    clearAtlasEnv();
    vi.stubEnv("STEEL_API_KEY", "");
    vi.stubEnv("ATLAS_STEEL_API_KEY", "");

    expect(() =>
      __testing.resolveRunConfig({
        query: "q",
        provider: "anthropic",
        model: "m",
      }),
    ).toThrow(/STEEL_API_KEY/);
  });
});
