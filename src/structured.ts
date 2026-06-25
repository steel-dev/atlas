import { generateObject, type FlexibleSchema } from "ai";
import type { AtlasConfig, ResearchOptions } from "./config.js";
import { resolveRunConfig } from "./config.js";
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
  config: AtlasConfig,
  options: ResearchOptions,
  result: ResearchResult,
  schema: FlexibleSchema<T>,
): Promise<T> {
  const resolved = resolveRunConfig(config, options);
  const { object } = await generateObject({
    model: resolved.models.write,
    schema,
    system: EXTRACT_SYSTEM,
    prompt:
      `Question:\n${result.question}\n\n` +
      `Research report:\n${result.report}\n\n` +
      "Return the object the schema defines, grounded only in the report above.",
    maxRetries: MODEL_CALL_MAX_RETRIES,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });
  return object;
}
