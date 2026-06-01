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
      "Fetch one or more URLs, store each page's full extracted text as a source document, and return a compact source card per page (source_id, metadata, chunk map, and a short preview). Raw text is not returned: use search_sources to find the relevant passages across stored sources, and read_source to read a chunk or pull an exact quote. Pass `url` for a single page, or `urls` to fetch several in parallel; multiple fetch calls in the same turn also run in parallel.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "A single absolute http(s) URL to fetch.",
        },
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "string",
            description: "Absolute http(s) URL to fetch.",
          },
          description:
            "Several absolute http(s) URLs to fetch and store in parallel. Use instead of `url` to build a broad source set in one call.",
        },
        preview_chars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FETCH_PREVIEW_CHARS,
          description: `Maximum preview characters per source card. Default ${DEFAULT_FETCH_PREVIEW_CHARS}, hard cap ${MAX_FETCH_PREVIEW_CHARS}.`,
        },
      },
    },
  },
  {
    name: "search_sources",
    description:
      "Search across the source documents you already fetched and return ranked matching snippets, each with a source_id, chunk_index, and a character span (start/end) you can pass straight to read_source. Restrict to one or a few sources with `source_ids` to search within them; omit it to search every stored source. Use this after fetching to locate the exact passages worth reading or quoting.",
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
          description:
            "Optional source IDs to restrict the search to specific stored sources, such as source_1. Omit to search every stored source.",
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
      "Create an optional goal-focused digest of a stored source to help navigation. This is not evidence and must not replace raw verification; use read_source before relying on a claim.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Source ID returned by fetch, such as source_1.",
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
    name: "read_source",
    description:
      "Read exact text from a source you already fetched. Pass `chunk_index` to read a numbered chunk and page through the document (default 0; the result links the previous/next chunk). Pass `start` and `end` to pull an exact character-span quote to cite. Use the source_id and spans returned by fetch or search_sources. This is the verification step: confirm a claim against raw text here before relying on it.",
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
          description:
            "Zero-based chunk to read. Default 0. Ignored when start/end are given.",
        },
        start: {
          type: "integer",
          minimum: 0,
          description:
            "Start character offset for an exact-span quote. Provide together with end.",
        },
        end: {
          type: "integer",
          minimum: 0,
          description:
            "End character offset for an exact-span quote. Provide together with start.",
        },
      },
      required: ["source_id"],
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
          description:
            "CDP method name, such as Runtime.evaluate or Page.navigate.",
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
    name: "spawn",
    description:
      "Launch one or more parallel sub-agents in the background and return their handles immediately WITHOUT waiting. Each sub-agent investigates ONE focused, self-contained sub-question in its OWN isolated context, searching and reading on its own. Sub-agents share your fetched-source store: a fetched source carries a source_id (a handle for search_sources/read_source) and a url (what you cite). Spawning does not block — keep searching, reading, or spawning more while they run, then call join to collect their cited findings. Spawn genuinely independent sub-questions for breadth; do simple single-thread lookups yourself. Sub-agents cannot see this conversation, so each question must carry all the context it needs.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description:
            "Self-contained sub-questions to investigate in parallel. Each must include all context the sub-agent needs.",
          items: {
            type: "string",
            description:
              "One self-contained sub-question, including all context the sub-agent needs.",
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "join",
    description:
      "Collect the cited findings of sub-agents started with spawn, blocking until they finish. Pass the handles you want, or omit handles to collect every outstanding sub-agent. Returns each sub-agent's concise findings plus the source_id and url of every source it fetched. Always join your sub-agents before writing the final report so their evidence is in context.",
    input_schema: {
      type: "object",
      properties: {
        handles: {
          type: "array",
          items: {
            type: "string",
            description:
              "A sub-agent handle returned by spawn, such as agent_1.",
          },
          description:
            "Handles to collect. Omit to join every outstanding sub-agent.",
        },
      },
    },
  },
];

export const RESEARCH_SYSTEM_PROMPT =
  "You are a deep research agent. Investigate the user's question with the available tools and answer it with well-supported, cited claims.\n\n" +
  "Ground every conclusion in the raw content of sources you actually fetched. Search snippets, source cards, source digests, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source and verify with read_source before relying on a claim. If the evidence contradicts your current hypothesis, revise it rather than forcing an answer.\n\n" +
  "Fetch broadly when needed: fetch stores full source documents (one url, or several with urls) without forcing summaries into your context. Use search_sources to find the relevant passages across stored documents, read_source to read a chunk or pull an exact quote, and digest_source only as an optional navigation aid for a specific current goal.\n\n" +
  "How you search and what you read is up to you. For interactive sites, internal site search, pagination, or pages where search/fetch is not enough, use browser_open and browser_cdp to inspect and navigate directly. When a browser page contains evidence you may cite, call browser_extract to store it as a source before relying on it in the final answer.\n\n" +
  "You scale yourself with two primitives: `spawn` launches parallel sub-agents in the background and returns immediately; `join` collects their cited findings, blocking until they finish. This one mechanism covers every shape of work, and you choose the shape per question: investigate simple single-thread questions yourself with no sub-agents; for a question that cleanly splits into independent parts, spawn that breadth up front and join once before writing; for an open-ended question where each step informs the next, spawn a focused round, join it, review what is still missing or unverified, then spawn another round on the gaps. You may also spawn, keep working yourself, and join later. Each sub-agent works in its own isolated context and returns a concise cited summary plus the source_id and url of each source it fetched, so prefer spawning breadth over reading many long pages yourself, and reuse those source_ids with read_source when you need exact wording.\n\n" +
  "Match the effort to the question and govern yourself by the budget status you are shown: do not spawn sub-agents for a question you can answer directly, and do not keep spawning rounds once the open questions are resolved. Always join every sub-agent you spawned before finalizing; never write the report while sub-agents are still outstanding or while important gaps remain.\n\n" +
  "To think, take stock, or re-plan without searching or fetching yet, call `plan` and keep going — it does not end the run. A turn with no tool calls is treated as your final answer, so only stop calling tools when you are ready to write the report. When you have enough evidence, write a cited Markdown report; if the evidence is incomplete, say so and explain the gaps. Cite every claim with the source's URL — as a Markdown link `[title](https://…)` or a bare https URL — so each citation is independently verifiable. Never cite an internal source_id (such as `source_6`) in the report; source_id values are only handles for the read/quote tools, not citations.";

export const SUBAGENT_SYSTEM_PROMPT =
  "You are a focused research sub-agent working on behalf of a lead researcher. You are investigating ONE specific sub-question. You cannot see the lead's conversation, so rely only on the sub-question text and what you fetch.\n\n" +
  "Ground every claim in the raw content of sources you actually fetched. Search snippets, source cards, source digests, URLs, and listing/SEO/directory pages are leads to follow, not evidence — follow them to a primary or detailed source and verify with read_source before relying on a claim. Use search/fetch/search_sources/read_source, and browser_open/browser_cdp/browser_extract for interactive sites, as needed.\n\n" +
  "Always investigate before answering: run at least one search and fetch at least one relevant source before writing your findings. Do not answer from prior knowledge alone — if you cannot find supporting sources, say so explicitly.\n\n" +
  "A turn with no tool calls is treated as your final answer. When you are done, write a concise findings summary — a few short paragraphs or bullet points, not a full report — and cite every claim with the source's full https URL inline. If the evidence is incomplete, state the gap plainly. Keep it tight: the lead only needs your findings and the source URLs, not a polished write-up.";

export const STRUCTURED_FINALIZE_SYSTEM_PROMPT =
  "You are finalizing a completed research run into a structured JSON result. The read-only source tools (search_sources, read_source) remain available, so confirm any quote against the source you already fetched before committing it. If one concrete missing fact prevents a correct JSON result, call request_more_research with the focused gap; otherwise do not search again. Quote only text that genuinely appears in those sources, and attribute each quote to the source it actually came from; never invent quotes, spans, or sources. When you are ready, respond with only the JSON object that matches the requested schema — no further tool calls, no prose, no Markdown fences.";

export const STRUCTURED_EMIT_SYSTEM_PROMPT =
  "You format a completed research run into JSON. Use only evidence already gathered in the conversation. Return only the JSON object matching the requested schema.";

export function researchQuestionPrompt(opts: {
  query: string;
  suggestedParallelism?: number;
}): string {
  const lines = [`Research question: ${opts.query}`];
  if (opts.suggestedParallelism && opts.suggestedParallelism >= 2) {
    lines.push(
      `You may run up to ${opts.suggestedParallelism} sub-agents in parallel with spawn. If this question splits into independent parts, spawn that breadth early and join before writing.`,
    );
  }
  return lines.join("\n\n");
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
