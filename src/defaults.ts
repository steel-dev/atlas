import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ResolvedModel } from "./model.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_ZAI_MODEL = "glm-5.2";
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

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

const CONTEXT_WINDOW_BY_PATTERN: ReadonlyArray<readonly [RegExp, number]> = [
  [/haiku|mini|nano|flash|lite/i, 200_000],
  [/opus|sonnet|fable|mythos/i, 1_000_000],
];
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CHARS_PER_TOKEN = 4;
const EXTRACTION_CONTEXT_FRACTION = 0.3;
const LEAD_CONTEXT_TARGET_TOKENS = 80_000;
const LEAD_CONTEXT_MAX_FRACTION = 0.4;

export function contextWindowTokens(model: ResolvedModel): number {
  const modelId = (model as LanguageModelV3).modelId ?? "";
  for (const [pattern, window] of CONTEXT_WINDOW_BY_PATTERN) {
    if (pattern.test(modelId)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function extractionCharsFor(model: ResolvedModel): number {
  return Math.round(
    contextWindowTokens(model) * EXTRACTION_CONTEXT_FRACTION * CHARS_PER_TOKEN,
  );
}

export function leadContextTokensFor(model: ResolvedModel): number {
  return Math.min(
    LEAD_CONTEXT_TARGET_TOKENS,
    Math.round(contextWindowTokens(model) * LEAD_CONTEXT_MAX_FRACTION),
  );
}
