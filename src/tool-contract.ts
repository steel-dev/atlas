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
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "string",
          },
          description: "One or more search queries to run in parallel.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum merged results to return.",
        },
      },
      required: ["queries"],
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
  {
    name: "read_source_chunk",
    description:
      "Read a numbered chunk from a source that was already fetched. Use source_id values returned by fetch.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Source ID returned by fetch, such as source_1.",
        },
        chunk_index: {
          type: "integer",
          minimum: 0,
          description: "Zero-based chunk index to read. Default 0.",
        },
      },
      required: ["source_id"],
    },
  },
  {
    name: "find_in_source",
    description:
      "Search within a source that was already fetched. Returns matching spans for quote_source.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Source ID returned by fetch, such as source_1.",
        },
        query: {
          type: "string",
          description: "Literal keyword or phrase to search for.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum matches to return. Default 5.",
        },
      },
      required: ["source_id", "query"],
    },
  },
  {
    name: "quote_source",
    description:
      "Return an exact quote from a fetched source by character span. Use spans from fetch/read_source_chunk/find_in_source.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Source ID returned by fetch, such as source_1.",
        },
        start: {
          type: "integer",
          minimum: 0,
          description: "Start character offset in the stored source markdown.",
        },
        end: {
          type: "integer",
          minimum: 0,
          description: "End character offset in the stored source markdown.",
        },
      },
      required: ["source_id", "start", "end"],
    },
  },
];

export const RESEARCH_SYSTEM_PROMPT =
  "You're a deep research agent. Use the available tools as needed to answer the user's question. Fetch returns source_id and chunk metadata for revisiting evidence with read_source_chunk, find_in_source, and quote_source. When you have enough evidence, stop using tools and write a cited Markdown report.";

export function researchQuestionPrompt(opts: { query: string }): string {
  return `Research question: ${opts.query}`;
}

export function finalSynthesisPrompt(reason: string): string {
  return (
    `Runtime limit reached: ${reason}.\n\n` +
    "Do not call any more tools. Using only the evidence already gathered in this conversation, write the best possible cited Markdown report. If the evidence is incomplete, state the uncertainty and gaps clearly."
  );
}
