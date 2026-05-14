import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";

const DEFAULT_EXTRACT_MODEL = "claude-haiku-4-5-20251001";
const MAX_SOURCE_CHARS = 100_000;

export function getAnthropic(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export interface ExtractResult {
  data: unknown;
  citations: Array<{ quote: string; field?: string }>;
}

export async function extractWithSchema(opts: {
  anthropic: Anthropic;
  markdown: string;
  schema: Record<string, unknown>;
  systemPrompt?: string;
  model?: string;
}): Promise<ExtractResult> {
  const { anthropic, markdown, schema, systemPrompt, model } = opts;

  const system =
    systemPrompt ??
    "You extract structured data from web pages. Output must match the provided schema exactly. For each populated field include a verbatim quote (≤200 chars) from the source as basis. If a field cannot be determined, omit it.";

  const wrappedSchema = {
    type: "object" as const,
    properties: {
      data: schema,
      citations: {
        type: "array",
        description: "Verbatim per-field citations from the source.",
        items: {
          type: "object",
          properties: {
            quote: {
              type: "string",
              description: "Verbatim quote (≤200 chars) from the source supporting a field.",
            },
            field: {
              type: "string",
              description: "JSON path of the field this quote supports (e.g. 'company.name').",
            },
          },
          required: ["quote"],
        },
      },
    },
    required: ["data", "citations"],
  };

  const response = await anthropic.messages.create({
    model: model ?? DEFAULT_EXTRACT_MODEL,
    max_tokens: 8192,
    system,
    tools: [
      {
        name: "submit_extraction",
        description: "Submit the extracted structured data with verbatim per-field citations.",
        input_schema: wrappedSchema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_extraction" },
    messages: [
      {
        role: "user",
        content: `Source page:\n\n${markdown.slice(0, MAX_SOURCE_CHARS)}`,
      },
    ],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) {
    throw new Error("LLM did not invoke submit_extraction");
  }
  const input = tool.input as ExtractResult;
  return {
    data: input.data,
    citations: Array.isArray(input.citations) ? input.citations : [],
  };
}
