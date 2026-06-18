import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { readEnv } from "./env.js";
import type { ResolvedModel } from "./model.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_ZAI_MODEL = "GLM-5.2";
export const DEFAULT_ANTHROPIC_SMALL_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_SMALL_MODEL = "gpt-5-mini";
export const DEFAULT_ZAI_SMALL_MODEL = "GLM-4.5-Air";
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

const SMALL_MODEL_ID_PATTERN = /haiku|mini|nano|flash|lite/i;
const ZAI_MODEL_ID_PATTERN = /^glm-/i;
const ZAI_SMALL_MODEL_ID_PATTERN = /^glm-4\.5-air$/i;

export function isSmallModelId(modelId: string): boolean {
  return (
    SMALL_MODEL_ID_PATTERN.test(modelId) ||
    ZAI_SMALL_MODEL_ID_PATTERN.test(modelId)
  );
}

export function isZaiModelId(modelId: string): boolean {
  return ZAI_MODEL_ID_PATTERN.test(modelId);
}

export function deriveSmallModel(
  lead: ResolvedModel,
): ResolvedModel | undefined {
  const inner = lead as LanguageModelV3;
  const provider = (inner.provider ?? "").toLowerCase();
  const modelId = inner.modelId ?? "";
  if (isSmallModelId(modelId)) return undefined;
  try {
    if (isZaiModelId(modelId)) {
      const apiKey = readEnv("ATLAS_ZAI_API_KEY", "ZAI_API_KEY");
      if (!apiKey) return undefined;
      const baseURL =
        readEnv("ATLAS_ZAI_BASE_URL", "ZAI_BASE_URL") ?? DEFAULT_ZAI_BASE_URL;
      return createOpenAI({ apiKey, baseURL })(DEFAULT_ZAI_SMALL_MODEL);
    }
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
