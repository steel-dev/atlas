import type { ModelToolDefinition } from "./model.js";

export const DEFAULT_FETCH_CHARS = 12_000;
export const MAX_FETCH_CHARS = 50_000;

export const RESEARCH_TOOLS: ModelToolDefinition[] = [
  {
    name: "search",
    description:
      "Search the web. `queries` may contain multiple distinct query variants that run in parallel and merge into one ranked list. Prefer batching several variants in a single call over many one-query searches.",
    input_schema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "string",
            description: "One complete search query string.",
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
      "Fetch a URL as Markdown. Multiple fetch calls in the same turn run in parallel. Use offset/max_chars to continue reading long pages. Returns a source_id and chunk metadata you can revisit with read_source_chunk, find_in_source, and quote_source.",
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
  {
    name: "plan",
    description:
      "Record a short plan, hypothesis, or next steps and keep going. Use this when you want to think, take stock, or re-plan before searching or fetching — it does not end the run. Only a turn with no tool calls ends the run, so reserve that for your final report.",
    input_schema: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description:
            "Your plan, hypothesis, or next steps. Stays in the transcript so you can build on it.",
        },
      },
      required: ["thought"],
    },
  },
];

export const RESEARCH_SYSTEM_PROMPT =
  "You are a deep research agent. Investigate the user's question with the available tools and answer it with well-supported, cited claims.\n\n" +
  "Ground every conclusion in the content of sources you actually fetched. Search snippets, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source and cite that instead. Verify a claim before you rely on it, and if the evidence contradicts your current hypothesis, revise it rather than forcing an answer.\n\n" +
  "How you search and what you read is up to you. To think, take stock, or re-plan without searching or fetching yet, call `plan` and keep going — it does not end the run. A turn with no tool calls is treated as your final answer, so only stop calling tools when you are ready to write the report. When you have enough evidence, write a cited Markdown report; if the evidence is incomplete, say so and explain the gaps.";

export const STRUCTURED_FINALIZE_SYSTEM_PROMPT =
  "You are finalizing a completed research run into a structured JSON result. The read-only source tools (find_in_source, quote_source, read_source_chunk) remain available, so confirm any quote against the source you already fetched before committing it. Quote only text that genuinely appears in those sources, and attribute each quote to the source it actually came from; never invent quotes, spans, or sources. When you are ready, respond with only the JSON object that matches the requested schema — no further tool calls, no prose, no Markdown fences.";

export const STRUCTURED_EMIT_SYSTEM_PROMPT =
  "You format a completed research run into JSON. Use only evidence already gathered in the conversation. Return only the JSON object matching the requested schema.";

export function researchQuestionPrompt(opts: { query: string }): string {
  return `Research question: ${opts.query}`;
}

export function finalSynthesisPrompt(reason: string): string {
  return (
    `Runtime limit reached: ${reason}.\n\n` +
    "Do not call any more tools. Using only the evidence already gathered in this conversation, write the best possible cited Markdown report. If the evidence is incomplete, state the uncertainty and gaps clearly."
  );
}
