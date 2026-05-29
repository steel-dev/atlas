import { describe, expect, it } from "vitest";
import { __testing } from "./research.js";
import {
  emptyUsageSummary,
  type ModelAdapter,
  type ModelAssistantBlock,
  type ModelStepInput,
} from "./model.js";
import type { ResearchLoopContext } from "./tools.js";
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

function singleSourceContext(document: SourceDocument): ResearchLoopContext {
  const sourceDocuments = new Map<string, SourceDocument>([
    [document.canonicalUrl, document],
  ]);
  return { sourceDocuments } as unknown as ResearchLoopContext;
}

function followupResearchContext(model: ModelAdapter): ResearchLoopContext {
  return {
    model,
    fetchedSources: [],
    sourceDocuments: new Map(),
    emit: () => undefined,
    abort: () => undefined,
    defaultEngine: "ddg",
    useProxy: false,
    sourceCap: 10,
  } as unknown as ResearchLoopContext;
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
    const audit = __testing.auditCitationsInMarkdown(
      "Evidence from [Example](https://example.com/report?utm_source=newsletter&b=2&a=1#section).",
      [
        {
          url: "https://example.com/report?a=1&b=2",
          title: "Example Report",
        },
      ],
    );

    expect(audit.verifiedSources).toEqual([
      {
        url: "https://example.com/report?a=1&b=2",
        title: "Example Report",
      },
    ]);
    expect(audit.unverifiedCitations).toEqual([]);
  });

  it("does not promote unfetched cited URLs into verified sources", () => {
    const audit = __testing.auditCitationsInMarkdown(
      [
        "Verified evidence from [Fetched](https://example.com/fetched).",
        "Unverified claim from [Unfetched](https://example.com/unfetched).",
        "Repeated bare URL should dedupe: https://example.com/unfetched.",
      ].join("\n"),
      [
        {
          url: "https://example.com/fetched",
          title: "Fetched Source",
        },
      ],
    );

    expect(audit.verifiedSources).toEqual([
      {
        url: "https://example.com/fetched",
        title: "Fetched Source",
      },
    ]);
    expect(audit.unverifiedCitations).toEqual([
      "https://example.com/unfetched",
    ]);
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
      "find_in_source",
      "quote_source",
      "read_source_chunk",
      "request_more_research",
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
    expect(JSON.stringify(calls[2]?.messages)).toContain("Missing date is 2020");
  });

  it("executes a quote_source call and returns the verified JSON", async () => {
    const markdown = "Nicholas Munene Mutuma is a Kenyan actor.";
    const ctx = singleSourceContext(sourceDocument(markdown));
    const { adapter, calls } = fakeModel([
      [
        {
          type: "tool_call",
          id: "call_1",
          name: "quote_source",
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
    // The tool call was actually executed and its real quote fed back to the model.
    expect(JSON.stringify(calls[1]?.messages)).toContain("Nicholas Munene Mutuma");
  });
});
