import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { readEnv } from "./env.js";
import type { ResolvedModel } from "./model.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_ANTHROPIC_SMALL_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_SMALL_MODEL = "gpt-5-mini";

const SMALL_MODEL_ID_PATTERN = /haiku|mini|nano|flash|lite/i;

export function isSmallModelId(modelId: string): boolean {
  return SMALL_MODEL_ID_PATTERN.test(modelId);
}

export function deriveSmallModel(
  lead: ResolvedModel,
): ResolvedModel | undefined {
  const inner = lead as LanguageModelV3;
  const provider = (inner.provider ?? "").toLowerCase();
  const modelId = inner.modelId ?? "";
  if (SMALL_MODEL_ID_PATTERN.test(modelId)) return undefined;
  try {
    if (provider.includes("anthropic")) {
      const apiKey = readEnv("ATLAS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
      if (!apiKey) return undefined;
      return createAnthropic({ apiKey })(DEFAULT_ANTHROPIC_SMALL_MODEL);
    }
    if (provider.includes("openai")) {
      const apiKey = readEnv("ATLAS_OPENAI_API_KEY", "OPENAI_API_KEY");
      if (!apiKey) return undefined;
      return createOpenAI({ apiKey })(DEFAULT_OPENAI_SMALL_MODEL);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
