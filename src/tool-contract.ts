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
      "Fetch a URL and get a concise, question-focused summary of the page plus a source_id. The full page is stored: read exact text with read_source_chunk, find_in_source, and quote_source, or fetch the same URL again (optionally with offset) to read raw Markdown. Multiple fetch calls in the same turn run in parallel.",
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
    name: "browser_open",
    description:
      "Open a persistent browser session, optionally navigating to an absolute URL. Use this when a task needs interactive browsing beyond search/fetch.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Optional absolute http(s) URL to open.",
        },
      },
    },
  },
  {
    name: "browser_cdp",
    description:
      "Send an allowlisted Chrome DevTools Protocol command to the open browser session. Use Runtime.evaluate, DOM, Accessibility, Network, Page, and Target commands to inspect and interact with pages directly.",
    input_schema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "CDP method name, such as Runtime.evaluate or Page.navigate.",
        },
        params: {
          type: "object",
          description: "CDP command parameters.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Optional per-command timeout in milliseconds.",
        },
      },
      required: ["method"],
    },
  },
  {
    name: "browser_extract",
    description:
      "Store the current browser page as a fetched source and return source_id/chunk metadata. Use before citing evidence found through browser_cdp.",
    input_schema: {
      type: "object",
      properties: {
        max_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_CHARS,
          description: `Maximum source content characters to return. Default ${DEFAULT_FETCH_CHARS}.`,
        },
      },
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
  {
    name: "delegate",
    description:
      "Spawn parallel sub-agents, each investigating ONE focused, self-contained sub-question in its OWN isolated context. Each sub-agent searches and reads on its own and returns a concise cited summary — not raw pages — so your context stays clean. Sub-agents share your fetched-source store: each returned source carries a source_id (a handle for quote_source/read_source_chunk/find_in_source) and a url (what you cite). Use this to fan out genuinely independent sub-questions for breadth; do simple, single-thread lookups yourself with search/fetch. Sub-agents cannot see this conversation, so each question must include all context it needs.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "Independent sub-questions to investigate in parallel.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description:
                  "A self-contained sub-question, including all context the sub-agent needs (it cannot see this conversation).",
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["tasks"],
    },
  },
];

export const RESEARCH_SYSTEM_PROMPT =
  "You are a deep research agent. Investigate the user's question with the available tools and answer it with well-supported, cited claims.\n\n" +
  "Ground every conclusion in the content of sources you actually fetched. Search snippets, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source and cite that instead. Verify a claim before you rely on it, and if the evidence contradicts your current hypothesis, revise it rather than forcing an answer.\n\n" +
  "How you search and what you read is up to you. For interactive sites, internal site search, pagination, or pages where search/fetch is not enough, use browser_open and browser_cdp to inspect and navigate directly. When a browser page contains evidence you may cite, call browser_extract to store it as a source before relying on it in the final answer.\n\n" +
  "When the question splits into independent sub-questions that can be investigated separately, call `delegate` to run them as parallel sub-agents. Each sub-agent works in its own isolated context and returns a concise cited summary plus the source_id and url of each source it fetched — so prefer delegating breadth over reading many long pages yourself, and reuse those source_ids with quote_source when you need exact wording. Investigate simple, single-thread questions directly.\n\n" +
  "To think, take stock, or re-plan without searching or fetching yet, call `plan` and keep going — it does not end the run. A turn with no tool calls is treated as your final answer, so only stop calling tools when you are ready to write the report. When you have enough evidence, write a cited Markdown report; if the evidence is incomplete, say so and explain the gaps. Cite every claim with the source's URL — as a Markdown link `[title](https://…)` or a bare https URL — so each citation is independently verifiable. Never cite an internal source_id (such as `source_6`) in the report; source_id values are only handles for the read/quote tools, not citations.";

export const SUBAGENT_SYSTEM_PROMPT =
  "You are a focused research sub-agent working on behalf of a lead researcher. You are investigating ONE specific sub-question. You cannot see the lead's conversation, so rely only on the sub-question text and what you fetch.\n\n" +
  "Ground every claim in the content of sources you actually fetched. Search snippets, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source. Verify before you rely on a claim, and revise your hypothesis if the evidence contradicts it. Use search and fetch, and browser_open/browser_cdp/browser_extract for interactive sites, as needed.\n\n" +
  "Always investigate before answering: run at least one search and fetch at least one relevant source before writing your findings. Do not answer from prior knowledge alone — if you cannot find supporting sources, say so explicitly.\n\n" +
  "A turn with no tool calls is treated as your final answer. When you are done, write a concise findings summary — a few short paragraphs or bullet points, not a full report — and cite every claim with the source's full https URL inline. If the evidence is incomplete, state the gap plainly. Keep it tight: the lead only needs your findings and the source URLs, not a polished write-up.";

export const STRUCTURED_FINALIZE_SYSTEM_PROMPT =
  "You are finalizing a completed research run into a structured JSON result. The read-only source tools (find_in_source, quote_source, read_source_chunk) remain available, so confirm any quote against the source you already fetched before committing it. If one concrete missing fact prevents a correct JSON result, call request_more_research with the focused gap; otherwise do not search again. Quote only text that genuinely appears in those sources, and attribute each quote to the source it actually came from; never invent quotes, spans, or sources. When you are ready, respond with only the JSON object that matches the requested schema — no further tool calls, no prose, no Markdown fences.";

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

export const FETCH_SUMMARY_SYSTEM_PROMPT =
  "You compress one fetched web page for a research agent. Given the research question and the page text, return only what is relevant to the question: the key facts, figures, names, and dates, plus up to three short verbatim quotes copied exactly from the text. Be strictly faithful — never add, infer, or guess anything that is not present. If the page is not relevant to the question, say so in one sentence. Keep the whole response under about 120 words, as plain text with no headings or preamble.";

export function fetchSummaryPrompt(opts: {
  query: string;
  title: string;
  url: string;
  content: string;
}): string {
  return [
    `Research question: ${opts.query}`,
    `Source: ${opts.title} (${opts.url})`,
    "Page text:",
    opts.content,
  ].join("\n\n");
}
