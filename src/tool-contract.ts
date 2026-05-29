import type { ModelToolDefinition } from "./model.js";

export const DEFAULT_FETCH_PREVIEW_CHARS = 700;
export const MAX_FETCH_PREVIEW_CHARS = 2_000;

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
      "Fetch a URL, store its full extracted text as a source document, and return a compact source card with source_id, metadata, chunks, and a short preview. This does not summarize or replace the raw source: use search_sources to search stored documents, read_source_chunk for raw text, digest_source for an optional goal-focused map, and quote_source for exact evidence. Multiple fetch calls in the same turn run in parallel.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch.",
        },
        preview_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_PREVIEW_CHARS,
          description: `Maximum preview characters to include in the source card. Default ${DEFAULT_FETCH_PREVIEW_CHARS}, hard cap ${MAX_FETCH_PREVIEW_CHARS}.`,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_many",
    description:
      "Fetch and store several URLs in parallel, returning compact source cards. Use this to build a broad source set before narrowing with search_sources/read_source_chunk. Each fetched page is stored as a source document; raw text is not returned by default.",
    input_schema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "string",
            description: "Absolute http(s) URL to fetch.",
          },
          description: "URLs to fetch and store.",
        },
        preview_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_PREVIEW_CHARS,
          description: `Maximum preview characters per source card. Default ${DEFAULT_FETCH_PREVIEW_CHARS}, hard cap ${MAX_FETCH_PREVIEW_CHARS}.`,
        },
      },
      required: ["urls"],
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
    name: "search_sources",
    description:
      "Search across stored source documents and return ranked matching chunks/snippets with source_id and character spans. Use this after fetching many sources to decide what raw chunks or quotes to inspect.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Literal keywords or phrases to search for across stored sources. Quoted phrases are treated as phrases.",
        },
        source_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional source IDs to restrict the search.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Maximum matching chunks to return. Default 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "digest_source",
    description:
      "Create an optional goal-focused digest of a stored source to help navigation. This is not evidence and must not replace raw verification; use read_source_chunk or quote_source before relying on a claim.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Source ID returned by fetch or fetch_many, such as source_1.",
        },
        goal: {
          type: "string",
          description:
            "What you are trying to learn from this source right now. The digest will use this as its lens.",
        },
      },
      required: ["source_id", "goal"],
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
      "Store the current browser page as a fetched source and return a compact source card with source_id/chunk metadata. Use before citing evidence found through browser_cdp.",
    input_schema: {
      type: "object",
      properties: {
        max_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_PREVIEW_CHARS,
          description: `Maximum preview characters to return in the source card. Default ${DEFAULT_FETCH_PREVIEW_CHARS}.`,
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
      "Spawn parallel sub-agents, each investigating ONE focused, self-contained sub-question in its OWN isolated context. Each sub-agent searches and reads on its own and returns a concise cited summary — not raw pages — so your context stays clean. Sub-agents share your fetched-source store: each returned source carries a source_id (a handle for search_sources, read_source_chunk, find_in_source, and quote_source) and a url (what you cite). Use this to fan out genuinely independent sub-questions for breadth; do simple, single-thread lookups yourself with search/fetch/fetch_many. Sub-agents cannot see this conversation, so each question must include all context it needs.",
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
  "Ground every conclusion in the raw content of sources you actually fetched. Search snippets, source cards, source digests, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source and verify with read_source_chunk or quote_source before relying on a claim. If the evidence contradicts your current hypothesis, revise it rather than forcing an answer.\n\n" +
  "Fetch broadly when needed: fetch and fetch_many store full source documents without forcing summaries into your context. Use search_sources to search across stored documents, digest_source only as an optional navigation aid for a specific current goal, and quote_source for exact wording.\n\n" +
  "How you search and what you read is up to you. For interactive sites, internal site search, pagination, or pages where search/fetch is not enough, use browser_open and browser_cdp to inspect and navigate directly. When a browser page contains evidence you may cite, call browser_extract to store it as a source before relying on it in the final answer.\n\n" +
  "When the question splits into independent sub-questions that can be investigated separately, call `delegate` to run them as parallel sub-agents. Each sub-agent works in its own isolated context and returns a concise cited summary plus the source_id and url of each source it fetched — so prefer delegating breadth over reading many long pages yourself, and reuse those source_ids with quote_source when you need exact wording. Investigate simple, single-thread questions directly.\n\n" +
  "To think, take stock, or re-plan without searching or fetching yet, call `plan` and keep going — it does not end the run. A turn with no tool calls is treated as your final answer, so only stop calling tools when you are ready to write the report. When you have enough evidence, write a cited Markdown report; if the evidence is incomplete, say so and explain the gaps. Cite every claim with the source's URL — as a Markdown link `[title](https://…)` or a bare https URL — so each citation is independently verifiable. Never cite an internal source_id (such as `source_6`) in the report; source_id values are only handles for the read/quote tools, not citations.";

export const SUBAGENT_SYSTEM_PROMPT =
  "You are a focused research sub-agent working on behalf of a lead researcher. You are investigating ONE specific sub-question. You cannot see the lead's conversation, so rely only on the sub-question text and what you fetch.\n\n" +
  "Ground every claim in the raw content of sources you actually fetched. Search snippets, source cards, source digests, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source and verify with read_source_chunk or quote_source before relying on a claim. Use search/fetch/fetch_many/search_sources, and browser_open/browser_cdp/browser_extract for interactive sites, as needed.\n\n" +
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

export const DIGEST_SOURCE_SYSTEM_PROMPT =
  "You create a navigation digest for one stored source document. Given the agent's current goal and the page text, map the most promising facts, names, dates, terms, and sections to inspect next. Be strictly faithful — never add, infer, or guess anything that is not present. Do not decide that the source is irrelevant unless the text clearly supports that. Include short exact phrases only as waypoints, not final evidence. Keep the response under about 180 words as plain text with no preamble.";

export function digestSourcePrompt(opts: {
  goal: string;
  title: string;
  url: string;
  content: string;
}): string {
  return [
    `Current goal: ${opts.goal}`,
    `Source: ${opts.title} (${opts.url})`,
    "Page text:",
    opts.content,
  ].join("\n\n");
}
