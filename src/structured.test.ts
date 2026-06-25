import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractStructured } from "./structured.js";

const USAGE = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};

function jsonModel(obj: unknown): LanguageModelV3 {
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
  }) as unknown as LanguageModelV3;
}

describe("extractStructured", () => {
  it("extracts a schema-conforming object from the report", async () => {
    const schema = z.object({ revenue: z.number(), ceo: z.string() });
    const object = await extractStructured(
      jsonModel({ revenue: 12.3, ceo: "Jane" }),
      "What were revenue and CEO?",
      "Revenue was $12.3B; the CEO is Jane.",
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
    }) as unknown as LanguageModelV3;
    await extractStructured(
      model,
      "What were revenue and CEO?",
      "UNIQUE_REPORT_BODY",
      z.object({ answer: z.string() }),
    );
    expect(seenPrompt).toContain("UNIQUE_REPORT_BODY");
  });
});
