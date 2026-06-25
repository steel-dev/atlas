import type { LanguageModelV3 } from "@ai-sdk/provider";
import { type FlexibleSchema, generateObject } from "ai";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { ResearchResult } from "./run.js";

export interface StructuredResult<T> extends ResearchResult {
  object: T;
}

const EXTRACT_SYSTEM =
  "You convert a finished research report into a structured object that conforms to the given schema. " +
  "Use ONLY facts asserted in the report; never invent or infer a value the report does not support. " +
  "When the report leaves a field undetermined, use the schema's allowance — null, empty, or omission — rather than guessing.";

export async function extractStructured<T>(
  model: LanguageModelV3,
  question: string,
  report: string,
  schema: FlexibleSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { object } = await generateObject({
    model,
    schema,
    system: EXTRACT_SYSTEM,
    prompt:
      `Question:\n${question}\n\n` +
      `Research report:\n${report}\n\n` +
      "Return the object the schema defines, grounded only in the report above.",
    maxRetries: MODEL_CALL_MAX_RETRIES,
    ...(signal ? { abortSignal: signal } : {}),
  });
  return object;
}
