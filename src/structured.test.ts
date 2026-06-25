import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractStructured } from "./structured.js";
import type { AtlasConfig } from "./config.js";
import type { ResearchResult } from "./run.js";

const USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function jsonModel(obj: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "claude-sonnet-4-6",
    doGenerate: async (
      _options: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

function reportResult(report: string): ResearchResult {
  return {
    runId: "r1",
    question: "What were revenue and CEO?",
    report,
    note: "",
    sources: [],
    citations: [],
    unsupportedSentences: [],
    warnings: [],
    stats: {} as ResearchResult["stats"],
    eventVersion: "x",
  };
}

describe("extractStructured", () => {
  it("extracts a schema-conforming object from the report", async () => {
    const cfg: AtlasConfig = { model: jsonModel({ revenue: 12.3, ceo: "Jane" }) };
    const schema = z.object({ revenue: z.number(), ceo: z.string() });
    const object = await extractStructured(
      cfg,
      {},
      reportResult("Revenue was $12.3B; the CEO is Jane."),
      schema,
    );
    expect(object).toEqual({ revenue: 12.3, ceo: "Jane" });
  });

  it("passes the report text to the extraction model", async () => {
    let seenPrompt = "";
    const model = new MockLanguageModelV3({
      provider: "mock-provider",
      modelId: "claude-sonnet-4-6",
      doGenerate: async (
        options: LanguageModelV3CallOptions,
      ): Promise<LanguageModelV3GenerateResult> => {
        seenPrompt = JSON.stringify(options.prompt);
        return {
          content: [{ type: "text", text: JSON.stringify({ answer: "ok" }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });
    await extractStructured(
      { model },
      {},
      reportResult("UNIQUE_REPORT_BODY"),
      z.object({ answer: z.string() }),
    );
    expect(seenPrompt).toContain("UNIQUE_REPORT_BODY");
  });
});
