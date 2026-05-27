import type { ModelToolDefinition } from "./model.js";

export const DEFAULT_FETCH_CHARS = 12_000;
export const MAX_FETCH_CHARS = 50_000;

export const RESEARCH_TOOLS: ModelToolDefinition[] = [
  {
    name: "search",
    description: "Search the web.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum results to return.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description:
      "Fetch a URL as Markdown. Use offset/max_chars to continue reading long pages.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to start reading from. Default 0.",
        },
        max_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_CHARS,
          description: `Maximum characters to return. Default ${DEFAULT_FETCH_CHARS}, hard cap ${MAX_FETCH_CHARS}.`,
        },
      },
    },
  },
];

export const RESEARCH_SYSTEM_PROMPT =
  "You're a deep research agent. Use the available tools as needed to answer the user's question. When you have enough evidence, stop using tools and write a cited Markdown report.";

export function researchQuestionPrompt(opts: { query: string }): string {
  return `Research question: ${opts.query}`;
}

export function finalSynthesisPrompt(reason: string): string {
  return (
    `Runtime limit reached: ${reason}.\n\n` +
    "Do not call any more tools. Using only the evidence already gathered in this conversation, write the best possible cited Markdown report. If the evidence is incomplete, state the uncertainty and gaps clearly."
  );
}
