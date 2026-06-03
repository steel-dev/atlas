import {
  totalUsageTokens,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolResult,
} from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import { errorMessage } from "./errors.js";
import { normalizeUrlForSource } from "./url.js";
import { createSourceDocument } from "./source-documents.js";
import {
  compileUserTool,
  type CompiledUserTool,
  type ResearchTool,
  type ResearchToolContext,
} from "./research-tool.js";
import {
  DEFAULT_FETCH_PREVIEW_CHARS,
  MAX_FETCH_PREVIEW_CHARS,
} from "./tool-contract.js";
import { execSearch, type SearchToolInput } from "./search-tool.js";
import { execFetch, type FetchToolInput } from "./fetch-tool.js";
import {
  execDigestSource,
  execReadSource,
  execSearchSources,
  type DigestSourceToolInput,
  type ReadSourceToolInput,
  type SearchSourcesToolInput,
} from "./evidence-tool.js";
import { execRunCode, type RunCodeToolInput } from "./code-tool.js";
import {
  MAX_WAIT_TIMEOUT_MS,
  NO_MESSAGING,
  type MessagingScope,
} from "./messaging.js";
import {
  execBrowserCdp,
  execBrowserExtract,
  execBrowserOpen,
  type BrowserCdpToolInput,
  type BrowserExtractToolInput,
  type BrowserOpenToolInput,
} from "./browser-tool.js";

export const SPAWN_MAX_TASKS = 4;

interface ToolExecution {
  toolResult: ModelToolResult;
  fetchedUrl?: string;
  fetchedUrls?: string[];
}

interface ToolHandlerResult {
  content: string;
  isError?: boolean;
  fetchedUrl?: string;
  fetchedUrls?: string[];
}

interface ToolHandlerExtras {
  subagents: SubagentScope;
  messaging: MessagingScope;
  searchIndex?: number;
}

type ToolHandler = (
  input: unknown,
  ctx: ResearchCtx,
  extras: ToolHandlerExtras,
) => ToolHandlerResult | Promise<ToolHandlerResult>;

interface RegisteredTool {
  definition: ModelToolDefinition;
  /** Counts against the action-tool-call budget. Navigation/bookkeeping tools
   *  (plan, join, the read-only source tools) are free. */
  spendsActionBudget: boolean;
  /** Only offered to the lead (and above the max delegation depth); filtered
   *  out for the deepest agents, which research directly. */
  delegationOnly?: boolean;
  messagingOnly?: boolean;
  handler: ToolHandler;
}

export interface SubagentSummary {
  task: string;
  findings?: string;
  sources?: Array<{ source_id?: string; url: string; title?: string }>;
  tool_calls?: number;
  finish_reason?: string;
  error?: string;
}

interface SpawnResult {
  handles: Array<{ handle: string; task: string }>;
  error?: string;
}

interface JoinResult {
  summaries: SubagentSummary[];
  fetchedUrls: string[];
  error?: string;
}

export interface SubagentScope {
  spawn(tasks: string[]): SpawnResult;
  join(handles: string[] | undefined): Promise<JoinResult>;
  settle(): Promise<string[]>;
}

function readSpawnTasks(input: unknown): string[] {
  const raw =
    input &&
    typeof input === "object" &&
    Array.isArray((input as { tasks?: unknown }).tasks)
      ? (input as { tasks: unknown[] }).tasks
      : [];
  const seen = new Set<string>();
  const tasks: string[] = [];
  for (const entry of raw) {
    const question =
      typeof entry === "string"
        ? entry.trim()
        : entry &&
            typeof entry === "object" &&
            typeof (entry as { question?: unknown }).question === "string"
          ? (entry as { question: string }).question.trim()
          : "";
    if (!question || seen.has(question)) continue;
    seen.add(question);
    tasks.push(question);
    if (tasks.length >= SPAWN_MAX_TASKS) break;
  }
  return tasks;
}

function readJoinHandles(input: unknown): string[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = (input as { handles?: unknown }).handles;
  if (!Array.isArray(raw)) return undefined;
  const handles = raw
    .map((handle) => (typeof handle === "string" ? handle.trim() : ""))
    .filter((handle) => handle.length > 0);
  return handles.length > 0 ? handles : undefined;
}

function readSendMessageInput(input: unknown): { to: string; content: string } {
  const obj = (input ?? {}) as { to?: unknown; content?: unknown };
  return {
    to: typeof obj.to === "string" ? obj.to.trim() : "",
    content: typeof obj.content === "string" ? obj.content : "",
  };
}

function readWaitTimeoutMs(input: unknown): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = (input as { timeout_ms?: unknown }).timeout_ms;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(MAX_WAIT_TIMEOUT_MS, Math.floor(raw)));
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
    spendsActionBudget: true,
    handler: async (input, ctx, extras) => ({
      content: await execSearch(
        (input as SearchToolInput) ?? {},
        ctx,
        extras.searchIndex ?? 0,
      ),
    }),
  },
  {
    definition: {
      name: "fetch",
      description:
        "Fetch one or more URLs, store each page's full extracted text as a source document, and return a compact source card per page (source_id, metadata, chunk count and uniform chunk size, and a short preview). Raw text is not returned: use search_sources to find the relevant passages across stored sources, and read_source to read a chunk by index or pull an exact quote. Pass `url` for a single page, or `urls` to fetch several in parallel; multiple fetch calls in the same turn also run in parallel.",
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
    spendsActionBudget: true,
    handler: async (input, ctx) => {
      const out = await execFetch((input as FetchToolInput) ?? {}, ctx);
      return {
        content: out.text,
        fetchedUrl: out.fetchedUrl,
        fetchedUrls: out.fetchedUrls,
      };
    },
  },
  {
    definition: {
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
    spendsActionBudget: false,
    handler: (input, ctx) => ({
      content: execSearchSources((input as SearchSourcesToolInput) ?? {}, ctx),
    }),
  },
  {
    definition: {
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
    spendsActionBudget: false,
    handler: async (input, ctx) => ({
      content: await execDigestSource(
        (input as DigestSourceToolInput) ?? {},
        ctx,
      ),
    }),
  },
  {
    definition: {
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
    spendsActionBudget: false,
    handler: (input, ctx) => ({
      content: execReadSource((input as ReadSourceToolInput) ?? {}, ctx),
    }),
  },
  {
    definition: {
      name: "run_code",
      description:
        "Run synchronous JavaScript over the full text of sources you already fetched to extract exact values (numbers, dates, table cells, named entities), compute (sums, conversions, comparisons), or verify claims across sources. In scope: `sources` (array of {source_id, url, title, text} with the FULL stored text), `grep(pattern, {source_ids?, ignore_case?, context?, max?})` returning [{source_id, url, offset, match, context}] (pass offset to read_source start/end to quote), and `print(...)` for output. The script's final expression is returned as `result`. No network, filesystem, require, process, fetch, or timers; output is capped at about 8000 characters. Prefer this over transcribing figures from previews or snippets when a claim hinges on an exact value or on reconciling figures across sources.",
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
        data: { output_chars: content.length, ...(isError ? { error: true } : {}) },
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
    spendsActionBudget: true,
    handler: async (input, ctx) => ({
      content: await execBrowserExtract(
        (input as BrowserExtractToolInput) ?? {},
        ctx,
      ),
    }),
  },
  {
    definition: {
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
    spendsActionBudget: false,
    handler: () => ({
      content:
        "Plan recorded. Continue with search/fetch, or write your final report when you have enough evidence.",
    }),
  },
  {
    definition: {
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
    spendsActionBudget: true,
    delegationOnly: true,
    handler: (input, _ctx, { subagents }) => {
      const tasks = readSpawnTasks(input);
      if (tasks.length === 0) {
        return {
          content:
            "spawn requires a non-empty `tasks` array of self-contained sub-questions.",
        };
      }
      const { handles, error } = subagents.spawn(tasks);
      if (error) return { content: error };
      return {
        content: JSON.stringify(
          {
            spawned: handles,
            note: "Sub-agents are running in the background. Call join (with these handles, or no arguments to collect all) to receive their cited findings before you finalize.",
          },
          null,
          2,
        ),
      };
    },
  },
  {
    definition: {
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
    spendsActionBudget: false,
    delegationOnly: true,
    handler: async (input, _ctx, { subagents }) => {
      const { summaries, fetchedUrls, error } = await subagents.join(
        readJoinHandles(input),
      );
      if (error) return { content: error };
      return {
        content: JSON.stringify({ joined: summaries }, null, 2),
        ...(fetchedUrls.length > 0 ? { fetchedUrls } : {}),
      };
    },
  },
  {
    definition: {
      name: "send_message",
      description:
        'Send a short message to another running agent without waiting for a reply. As the lead, message a running sub-agent (a handle returned by spawn, such as agent_1) to redirect, narrow, or extend its task mid-flight. As a sub-agent, message "lead" to report a significant interim finding or to surface a blocking ambiguity. Delivery is asynchronous: the recipient sees the message after its next tool call, or immediately if it is blocked in wait_for_message. Messages are capped at 8000 characters. Does not consume the action budget.',
      input_schema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              'Recipient address: "lead" for the lead researcher, or a sub-agent handle returned by spawn, such as agent_1.',
          },
          content: {
            type: "string",
            description: "The message text.",
          },
        },
        required: ["to", "content"],
      },
    },
    spendsActionBudget: false,
    messagingOnly: true,
    handler: (input, ctx, { messaging }) => {
      const { to, content } = readSendMessageInput(input);
      if (!to || !content.trim()) {
        return {
          content:
            'send_message requires `to` (an agent handle or "lead") and a non-empty `content`.',
          isError: true,
        };
      }
      const outcome = messaging.send(to, content);
      if (typeof outcome === "string") {
        return { content: outcome, isError: true };
      }
      ctx.scope.emit({
        type: "message_sent",
        from: messaging.address,
        to,
        chars: content.length,
      });
      return { content: JSON.stringify(outcome, null, 2) };
    },
  },
  {
    definition: {
      name: "wait_for_message",
      description:
        "Block until at least one message arrives in your inbox, then return every queued message. Resolves early when nothing can message you anymore (no_more_senders) or when the timeout passes (timed_out) — both are normal outcomes, not errors. Call it alone on its own turn: a parked wait holds one tool slot until it resolves, so do not batch it with other tool calls. The wait never eats into the time reserved for writing findings. Does not consume the action budget.",
      input_schema: {
        type: "object",
        properties: {
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: 600000,
            description: "Max time to wait for a message. Default 120000.",
          },
        },
      },
    },
    spendsActionBudget: false,
    messagingOnly: true,
    handler: async (input, _ctx, { messaging }) => {
      const timeoutMs = readWaitTimeoutMs(input);
      const outcome = await messaging.receive(
        timeoutMs === undefined ? undefined : { timeoutMs },
      );
      return { content: JSON.stringify(outcome, null, 2) };
    },
  },
];

const researchToolByName = new Map(
  RESEARCH_TOOL_REGISTRY.map((tool) => [tool.definition.name, tool]),
);

const RESEARCH_TOOL_NAMES = RESEARCH_TOOL_REGISTRY.map(
  (tool) => tool.definition.name,
);

export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set(
  RESEARCH_TOOL_NAMES,
);

export function compileUserTools(
  tools: Record<string, ResearchTool>,
): Map<string, CompiledUserTool> {
  const compiled = new Map<string, CompiledUserTool>();
  for (const [name, spec] of Object.entries(tools)) {
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new Error(
        `createResearcher: tool name "${name}" is reserved by a built-in tool. Choose a different name.`,
      );
    }
    compiled.set(name, compileUserTool(name, spec));
  }
  return compiled;
}

export function userToolDefinitions(ctx: ResearchCtx): ModelToolDefinition[] {
  const userTools = ctx.config.userTools;
  if (!userTools) return [];
  return [...userTools.values()].map((tool) => tool.definition);
}

async function runUserTool(
  tool: CompiledUserTool,
  input: unknown,
  ctx: ResearchCtx,
): Promise<ToolHandlerResult> {
  const addedUrls: string[] = [];
  const toolContext: ResearchToolContext = {
    addSource: (source) => registerToolSource(ctx, source, addedUrls),
    emit: (data) =>
      ctx.scope.emit({ type: "tool_event", tool: tool.definition.name, data }),
    signal: ctx.deps.signal,
    budget: {
      msRemaining:
        ctx.scope.deadlineAt !== undefined
          ? Math.max(0, ctx.scope.deadlineAt - Date.now())
          : undefined,
      tokensSpent: totalUsageTokens(ctx.deps.model.usage),
      tokenLimit: ctx.config.tokenLimit,
    },
  };
  const output = await tool.execute(input, toolContext);
  const content = typeof output === "string" ? output : output.content;
  return {
    content,
    ...(addedUrls.length > 0 ? { fetchedUrls: addedUrls } : {}),
  };
}

function registerToolSource(
  ctx: ResearchCtx,
  source: { url: string; title: string; content?: string },
  addedUrls: string[],
): string | undefined {
  const canonicalUrl = normalizeUrlForSource(source.url);
  const existing = ctx.store.fetchedSources.find(
    (fetched) =>
      (fetched.canonicalUrl ?? normalizeUrlForSource(fetched.url)) ===
      canonicalUrl,
  );
  if (existing) return existing.sourceId;
  if (source.content !== undefined) {
    const sourceId = `source_${ctx.store.sourceReservations.nextSourceNumber++}`;
    const document = createSourceDocument(
      source.url,
      source.title,
      source.content,
      { markdownChars: source.content.length, extractionNotes: [] },
      source.content.length,
      sourceId,
      canonicalUrl,
    );
    ctx.store.sourceDocuments.set(canonicalUrl, document);
    ctx.store.sourceDocumentsById.set(sourceId, document);
    ctx.store.fetchedSources.push({
      url: source.url,
      title: source.title,
      sourceId,
      canonicalUrl,
    });
    addedUrls.push(source.url);
    return sourceId;
  }
  ctx.store.fetchedSources.push({
    url: source.url,
    title: source.title,
    canonicalUrl,
  });
  addedUrls.push(source.url);
  return undefined;
}

/** The tool definitions offered to a model step. Delegation tools (spawn/join)
 *  are dropped for agents at the deepest allowed depth. */
export function researchToolDefinitions(
  opts: { includeDelegation?: boolean; includeMessaging?: boolean } = {},
): ModelToolDefinition[] {
  const includeDelegation = opts.includeDelegation ?? true;
  const includeMessaging = opts.includeMessaging ?? true;
  return RESEARCH_TOOL_REGISTRY.filter(
    (tool) =>
      (includeDelegation || !tool.delegationOnly) &&
      (includeMessaging || !tool.messagingOnly),
  ).map((tool) => tool.definition);
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
  const userTool = builtin ? undefined : ctx.config.userTools?.get(tu.name);
  if (!builtin && !userTool) {
    const available = [
      ...RESEARCH_TOOL_NAMES,
      ...(ctx.config.userTools ? [...ctx.config.userTools.keys()] : []),
    ].join(", ");
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: `Unknown tool: ${tu.name}. Available tools: ${available}.`,
        is_error: true,
      },
    };
  }

  try {
    const result = builtin
      ? await builtin.handler(tu.input, ctx, extras)
      : await runUserTool(userTool as CompiledUserTool, tu.input, ctx);
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      },
      ...(result.fetchedUrl !== undefined
        ? { fetchedUrl: result.fetchedUrl }
        : {}),
      ...(result.fetchedUrls ? { fetchedUrls: result.fetchedUrls } : {}),
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

const FINALIZE_TOOL_NAMES = new Set(["read_source", "search_sources"]);

export function finalizeToolDefinitions(): ModelToolDefinition[] {
  return RESEARCH_TOOL_REGISTRY.filter((tool) =>
    FINALIZE_TOOL_NAMES.has(tool.definition.name),
  ).map((tool) => tool.definition);
}

const NO_SUBAGENTS: SubagentScope = {
  spawn: () => ({
    handles: [],
    error: "Sub-agents are not available during finalization.",
  }),
  join: async () => ({
    summaries: [],
    fetchedUrls: [],
    error: "Sub-agents are not available during finalization.",
  }),
  settle: async () => [],
};

export async function executeFinalizeTool(
  tu: ModelToolCall,
  ctx: ResearchCtx,
): Promise<ToolExecution> {
  if (!FINALIZE_TOOL_NAMES.has(tu.name)) {
    return {
      toolResult: {
        type: "tool_result",
        tool_call_id: tu.id,
        content: `Tool ${tu.name} is not available while finalizing. Use read_source or search_sources to verify evidence, then return the JSON.`,
        is_error: true,
      },
    };
  }
  return executeResearchTool(tu, ctx, {
    subagents: NO_SUBAGENTS,
    messaging: NO_MESSAGING,
  });
}
