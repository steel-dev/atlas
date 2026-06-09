import type {
  ModelToolCall,
  ModelToolDefinition,
  ModelToolResult,
} from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import { runCustomTool } from "./custom-tools.js";
import { errorMessage } from "./errors.js";
import {
  DEFAULT_FETCH_PREVIEW_CHARS,
  MAX_FETCH_PREVIEW_CHARS,
} from "./tool-contract.js";
import { execSearch, type SearchToolInput } from "./search-tool.js";
import { execFetch, type FetchToolInput } from "./fetch-tool.js";
import {
  execReadSource,
  execSearchSources,
  type ReadSourceToolInput,
  type SearchSourcesToolInput,
} from "./evidence-tool.js";
import { execRunCode, type RunCodeToolInput } from "./code-tool.js";
import { runSurvey } from "./recall.js";
import {
  execBrowserCdp,
  execBrowserExtract,
  execBrowserOpen,
  type BrowserCdpToolInput,
  type BrowserExtractToolInput,
  type BrowserOpenToolInput,
} from "./browser-tool.js";

interface ToolExecution {
  toolResult: ModelToolResult;
}

interface ToolHandlerResult {
  content: string;
  isError?: boolean;
}

export interface ToolHandlerExtras {
  searchIndexRef: { next: number };
  surveyedGoals: string[];
  question?: string;
}

type ToolHandler = (
  input: unknown,
  ctx: ResearchCtx,
  extras: ToolHandlerExtras,
) => ToolHandlerResult | Promise<ToolHandlerResult>;

interface RegisteredTool {
  definition: ModelToolDefinition;
  /** Counts against the action-tool-call budget. Read-only source tools are
   *  free. */
  spendsActionBudget: boolean;
  handler: ToolHandler;
}

interface SurveyToolInput {
  goal?: string;
  queries?: string[];
}

function runCodeContentIsError(content: string): boolean {
  if (content.startsWith("Error:")) return true;
  try {
    const value = JSON.parse(content) as { error?: unknown };
    return typeof value === "object" && value !== null && "error" in value;
  } catch {
    return false;
  }
}

const RESEARCH_TOOL_REGISTRY: RegisteredTool[] = [
  {
    definition: {
      name: "survey",
      description:
        "Close one evidence gap in a single call: searches the web, fetches novel sources (skipping everything already stored), and extracts verbatim-quoted claims into the ledger. Returns the new claims. Prefer this over manual search-then-fetch when investigating a gap.",
      input_schema: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "The gap to close, as a self-contained statement of what evidence is missing.",
          },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string" },
            description:
              "Up to 3 web search queries to run. Omit to search with the goal text itself.",
          },
        },
        required: ["goal"],
      },
    },
    spendsActionBudget: true,
    handler: async (input, ctx, extras) => {
      const args = (input ?? {}) as SurveyToolInput;
      const goal = String(args.goal ?? "").trim();
      if (!goal) {
        return {
          content: "Error: survey requires a non-empty `goal`.",
          isError: true,
        };
      }
      const queries = Array.isArray(args.queries)
        ? args.queries.map((query) => String(query ?? ""))
        : undefined;
      const searchIndexStart = extras.searchIndexRef.next;
      extras.searchIndexRef.next += queries?.length || 1;
      const outcome = await runSurvey(ctx, {
        goal,
        ...(queries ? { queries } : {}),
        searchIndexStart,
        ...(extras.question ? { question: extras.question } : {}),
      });
      extras.surveyedGoals.push(goal);
      return {
        content: JSON.stringify(
          {
            goal: outcome.goal,
            queries_run: outcome.queriesRun,
            sources_fetched: outcome.sourcesFetched,
            url_dupes: outcome.urlDupes,
            budget_dropped: outcome.budgetDropped,
            new_claims: outcome.newClaims.map((claim) => ({
              id: claim.id,
              claim: claim.text,
              importance: claim.importance,
              source_quality: claim.sourceQuality,
              url: claim.url,
              source_id: claim.sourceId,
            })),
          },
          null,
          2,
        ),
      };
    },
  },
  {
    definition: {
      name: "search",
      description:
        "Search the web and return a ranked result list with snippets, without fetching anything. Use to preview a gap before committing a survey, or to find a specific page to fetch.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "One complete search query string.",
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
    spendsActionBudget: true,
    handler: async (input, ctx, extras) => {
      const args = (input ?? {}) as SearchToolInput;
      const index = extras.searchIndexRef.next;
      extras.searchIndexRef.next += Math.max(
        1,
        Array.isArray(args.queries) ? args.queries.length : 1,
      );
      return {
        content: await execSearch(args, ctx, index),
      };
    },
  },
  {
    definition: {
      name: "fetch",
      description:
        "Fetch one or more URLs, store each page's full extracted text as a source document (its claims are extracted into the ledger automatically), and return a compact source card per page including a short preview. Full page text is not returned inline: use search_sources to find passages and read_source to read or quote them.",
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
            description: "Several absolute http(s) URLs to fetch in parallel.",
          },
          goal: {
            type: "string",
            description:
              "What you are trying to learn from these pages. Claims are extracted against this goal; omit to use the overall research question.",
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
    spendsActionBudget: true,
    handler: async (input, ctx) => {
      const out = await execFetch((input as FetchToolInput) ?? {}, ctx);
      return { content: out.text };
    },
  },
  {
    definition: {
      name: "search_sources",
      description:
        "Search across the source documents already fetched and return ranked matching snippets, each with a source_id, chunk_index, and a character span (start/end) you can pass straight to read_source. Restrict with `source_ids` or omit it to search every stored source.",
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
              "Optional source IDs to restrict the search to, such as source_1.",
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
    spendsActionBudget: false,
    handler: (input, ctx) => ({
      content: execSearchSources((input as SearchSourcesToolInput) ?? {}, ctx),
    }),
  },
  {
    definition: {
      name: "read_source",
      description:
        "Read exact text from a stored source. Pass `chunk_index` to read a numbered chunk and page through the document (default 0), or `start` and `end` to pull an exact character-span quote. Use the source_id and spans returned by fetch, survey, or search_sources.",
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
    spendsActionBudget: false,
    handler: (input, ctx) => ({
      content: execReadSource((input as ReadSourceToolInput) ?? {}, ctx),
    }),
  },
  {
    definition: {
      name: "run_code",
      description:
        "Run synchronous JavaScript over the full text of stored sources to extract exact values (numbers, dates, table cells, named entities), compute (sums, conversions, comparisons), or reconcile figures across sources. In scope: `sources` (array of {source_id, url, title, text} with the FULL stored text), `grep(pattern, {source_ids?, ignore_case?, context?, max?})` returning [{source_id, url, offset, match, context}] (pass offset to read_source start/end to quote), and `print(...)`. The final expression is returned as `result`. No network, filesystem, require, process, fetch, or timers; output is capped at about 8000 characters.",
      input_schema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Synchronous JavaScript run over fetched sources. End with an expression to return a value; do not use top-level return.",
          },
          source_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional source IDs (such as source_1) to expose in `sources`. Omit to expose every fetched source.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: 10000,
            description:
              "Execution timeout in milliseconds. Default 5000, hard cap 10000.",
          },
        },
        required: ["code"],
      },
    },
    spendsActionBudget: true,
    handler: (input, ctx) => {
      const content = execRunCode((input as RunCodeToolInput) ?? {}, ctx);
      const isError = runCodeContentIsError(content);
      ctx.scope.emit({
        type: "tool_event",
        tool: "run_code",
        data: {
          output_chars: content.length,
          ...(isError ? { error: true } : {}),
        },
      });
      return {
        content,
        ...(isError ? { isError: true } : {}),
      };
    },
  },
  {
    definition: {
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
    spendsActionBudget: true,
    handler: async (input, ctx) => ({
      content: await execBrowserOpen(
        (input as BrowserOpenToolInput) ?? {},
        ctx,
      ),
    }),
  },
  {
    definition: {
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
    spendsActionBudget: true,
    handler: async (input, ctx) => ({
      content: await execBrowserCdp((input as BrowserCdpToolInput) ?? {}, ctx),
    }),
  },
  {
    definition: {
      name: "browser_extract",
      description:
        "Store the current browser page as a fetched source (its claims are extracted into the ledger automatically) and return a compact source card with source_id/chunk metadata. Use before relying on evidence found through browser_cdp.",
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
    spendsActionBudget: true,
    handler: async (input, ctx) => ({
      content: await execBrowserExtract(
        (input as BrowserExtractToolInput) ?? {},
        ctx,
      ),
    }),
  },
];

const researchToolByName = new Map(
  RESEARCH_TOOL_REGISTRY.map((tool) => [tool.definition.name, tool]),
);

const RESEARCH_TOOL_NAMES = RESEARCH_TOOL_REGISTRY.map(
  (tool) => tool.definition.name,
);

export function researchToolDefinitions(): ModelToolDefinition[] {
  return RESEARCH_TOOL_REGISTRY.map((tool) => tool.definition);
}

/** Whether a tool counts against the action-tool-call budget. Unknown tools
 *  spend by default. */
export function toolSpendsActionBudget(name: string): boolean {
  return researchToolByName.get(name)?.spendsActionBudget ?? true;
}

/** Run one tool call and shape it into a `ToolExecution`. Error handling is
 *  uniform: cancellation propagates for every tool, while any other failure
 *  becomes an `is_error` tool result the model can read and recover from. */
export async function executeResearchTool(
  tu: ModelToolCall,
  ctx: ResearchCtx,
  extras: ToolHandlerExtras,
): Promise<ToolExecution> {
  const builtin = researchToolByName.get(tu.name);
  const custom = builtin ? undefined : ctx.tools?.get(tu.name);
  if (!builtin && !custom) {
    const available = [
      ...RESEARCH_TOOL_NAMES,
      ...(ctx.tools ? [...ctx.tools.keys()] : []),
    ];
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: `Unknown tool: ${tu.name}. Available tools: ${available.join(", ")}.`,
        is_error: true,
      },
    };
  }

  try {
    const result = builtin
      ? await builtin.handler(tu.input, ctx, extras)
      : { content: await runCustomTool(ctx, custom!, tu.input) };
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: result.content,
        ...("isError" in result && result.isError ? { is_error: true } : {}),
      },
    };
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: `Tool error: ${errorMessage(err)}`,
        is_error: true,
      },
    };
  }
}
