import Anthropic from "@anthropic-ai/sdk";
import {
  WRITER_MODEL,
  writeReport,
  type CitedSource,
} from "./pipeline.js";
import { type Engine } from "./search.js";
import { createSteel } from "./steel.js";
import { runAgenticSubAgent, type AgentContext } from "./tools.js";

export const RESEARCH_DEFAULTS = {
  maxLeadTurns: 8,
  maxSources: 12,
  maxSubagentToolCalls: 12,
  subagentSourceCap: 4,
  perDomainCap: 2,
} as const;

export type { CitedSource } from "./pipeline.js";
export type { Engine } from "./search.js";

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface AgentRun {
  sub_question: string;
  source_ns: number[];
  tool_calls: number;
  finish_reason: string;
}

export interface ResearchResult {
  query: string;
  sub_questions: string[];
  lead_turns: number;
  agent_runs: AgentRun[];
  sources: CitedSource[];
  markdown: string;
  usage_summary: UsageSummary;
}

export type ResearchEvent =
  | { type: "lead_turn"; turn: number; spawned: number }
  | { type: "agent_started"; sub_question: string }
  | { type: "searching"; sub_question: string; index: number; query: string }
  | {
      type: "search_results";
      sub_question: string;
      index: number;
      count: number;
    }
  | {
      type: "search_failed";
      sub_question: string;
      index: number;
      error: string;
    }
  | { type: "fetching"; sub_question: string; url: string }
  | {
      type: "source_committed";
      sub_question: string;
      url: string;
      n: number;
      title: string;
    }
  | { type: "source_error"; sub_question: string; url: string; error: string }
  | { type: "agent_finished"; sub_question: string; sources_added: number }
  | { type: "writing"; sources_count: number }
  | { type: "written"; markdown_chars: number }
  | { type: "completed"; result: ResearchResult };

export interface ResearchOptions {
  query: string;
  anthropicApiKey: string;
  steelApiKey: string;
  steelBaseUrl?: string;
  /** Cap on cited sources. Default 12. */
  maxSources?: number;
  /** Cap on lead-agent turns (each turn can spawn multiple sub-agents in parallel). Default 8. */
  maxLeadTurns?: number;
  /** Per-sub-agent cap on tool calls (search / fetch / finish). Default 12. */
  maxToolCalls?: number;
  /** Default backend for the web search tool. */
  engine?: Engine;
  useProxy?: boolean;
  /** Override the sub-agent scout / page-summarizer / verifier model (Haiku by default). */
  fastModel?: string;
  /** Override the lead-agent + writer model (Sonnet by default). */
  writerModel?: string;
  /** Override JUST the lead-agent model. Falls back to writerModel. */
  leadModel?: string;
  /** Optional GitHub token used by the github search backend (raises rate limit). */
  githubToken?: string;
  onEvent?: (event: ResearchEvent) => void;
  signal?: AbortSignal;
}

interface SpawnSubagentInput {
  sub_question?: string;
}

const LEAD_TOOLS: Anthropic.Tool[] = [
  {
    name: "spawn_subagent",
    description:
      "Fire one focused scout sub-agent to research a single sub-question. " +
      "The scout has its own search/fetch tools, picks its own queries and backends, and commits high-quality sources to the shared pool. " +
      "Emit multiple spawn_subagent tool_use blocks in a single turn to run scouts IN PARALLEL — much faster than serial. " +
      "Returns: which [n] sources the scout added and the scout's finish reason. " +
      "Don't re-spawn for a sub-question already well-covered in the pool.",
    input_schema: {
      type: "object",
      properties: {
        sub_question: {
          type: "string",
          description:
            "Focused, independent sub-question. Concrete (specific dates/versions/comparison points), answerable from a few web sources, no overlap with other sub-questions.",
        },
      },
      required: ["sub_question"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "finalize",
    description:
      "Call when the source pool covers the user's question well. The writer phase starts immediately.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    } as Anthropic.Tool["input_schema"],
  },
];

const LEAD_SYSTEM = `You research questions by spawning parallel scout sub-agents and finalizing when the source pool covers the question. Decompose into 3-5 independent concrete sub-questions and spawn them in parallel (emit multiple tool calls in one turn).`;

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey,
    steelApiKey,
    steelBaseUrl,
    maxSources = RESEARCH_DEFAULTS.maxSources,
    maxLeadTurns = RESEARCH_DEFAULTS.maxLeadTurns,
    maxToolCalls = RESEARCH_DEFAULTS.maxSubagentToolCalls,
    engine = "ddg",
    useProxy = false,
    fastModel,
    writerModel,
    leadModel,
    githubToken,
    onEvent,
    signal,
  } = opts;

  if (!query || !query.trim()) {
    throw new Error("research: query is required");
  }
  if (!anthropicApiKey) {
    throw new Error("research: anthropicApiKey is required");
  }
  if (!steelApiKey) {
    throw new Error("research: steelApiKey is required");
  }

  const emit = (e: ResearchEvent) => {
    try {
      onEvent?.(e);
    } catch {
      // user callbacks must never break the pipeline
    }
  };
  const abort = () => signal?.throwIfAborted();

  const anthropic = new Anthropic({ apiKey: anthropicApiKey, maxRetries: 5 });
  const usageSummary = instrumentAnthropic(anthropic);
  const steel = createSteel({ apiKey: steelApiKey, baseUrl: steelBaseUrl });

  const sources: CitedSource[] = [];
  const sourceUrls = new Set<string>();
  const sourceMarkdowns = new Map<number, string>();
  const globalDomainCounts = new Map<string, number>();

  const ctx: AgentContext = {
    anthropic,
    steel,
    sources,
    sourceUrls,
    sourceMarkdowns,
    globalDomainCounts,
    emit,
    abort,
    signal,
    defaultEngine: engine,
    useProxy,
    fastModel,
    perDomainCap: RESEARCH_DEFAULTS.perDomainCap,
    globalSourceCap: maxSources,
    githubToken,
  };

  const lead = await runLeadAgent({
    anthropic,
    ctx,
    query,
    maxLeadTurns,
    maxSubagentToolCalls: maxToolCalls,
    subagentSourceCap: RESEARCH_DEFAULTS.subagentSourceCap,
    model: leadModel ?? writerModel ?? WRITER_MODEL,
    emit,
    abort,
  });

  abort();
  emit({ type: "writing", sources_count: sources.length });
  const { markdown } = await writeReport({
    anthropic,
    query,
    sources,
    source_texts: sourceMarkdowns,
    model: writerModel,
    signal,
  });
  emit({ type: "written", markdown_chars: markdown.length });

  const result: ResearchResult = {
    query,
    sub_questions: lead.sub_questions,
    lead_turns: lead.turns,
    agent_runs: lead.agent_runs,
    sources,
    markdown,
    usage_summary: { ...usageSummary },
  };

  emit({ type: "completed", result });
  return result;
}

interface LeadResult {
  sub_questions: string[];
  agent_runs: AgentRun[];
  turns: number;
}

/**
 * Lead agent loop. Tools: spawn_subagent (parallel sub-agent dispatch),
 * finalize. Sub-agent commits flow through the shared AgentContext, so when
 * the loop exits the source pool is fully populated.
 */
async function runLeadAgent(opts: {
  anthropic: Anthropic;
  ctx: AgentContext;
  query: string;
  maxLeadTurns: number;
  maxSubagentToolCalls: number;
  subagentSourceCap: number;
  model: string;
  emit: (e: ResearchEvent) => void;
  abort: () => void;
}): Promise<LeadResult> {
  const {
    anthropic,
    ctx,
    query,
    maxLeadTurns,
    maxSubagentToolCalls,
    subagentSourceCap,
    model,
    emit,
    abort,
  } = opts;

  const subQuestions: string[] = [];
  const agentRuns: AgentRun[] = [];
  let turn = 0;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Research question: ${query}\n\n` +
        `You have at most ${maxLeadTurns} turns and a global source-pool cap of ${ctx.globalSourceCap}. ` +
        `Each sub-agent has its own tool budget (${maxSubagentToolCalls} tool calls).\n\n` +
        `Begin: decompose the question into independent sub-questions and spawn parallel scouts.`,
    },
  ];

  while (turn < maxLeadTurns) {
    abort();
    turn += 1;

    let resp: Anthropic.Message;
    try {
      resp = await anthropic.messages.create(
        {
          model,
          max_tokens: 8192,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          system: LEAD_SYSTEM,
          tools: LEAD_TOOLS,
          messages,
          // ephemeral cache on last cacheable block; the system prompt + early
          // turns become a reusable prefix as turns accumulate.
          cache_control: { type: "ephemeral" },
        },
        { signal: ctx.signal },
      );
    } catch (err) {
      // SDK abort errors wrap the AbortSignal as APIUserAbortError (name
      // defaults to "Error"), so check the signal directly.
      if (ctx.signal?.aborted) throw err;
      // Lead-side API error: stop gathering but allow phase 2 to proceed
      // with whatever sources sub-agents already committed.
      break;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Lead stopped emitting tools without finalizing. Treat as implicit
      // finalize so the writer can still run.
      break;
    }

    const finalizeUse = toolUses.find((tu) => tu.name === "finalize");
    const spawnUses = toolUses.filter((tu) => tu.name === "spawn_subagent");
    const unknownUses = toolUses.filter(
      (tu) => tu.name !== "finalize" && tu.name !== "spawn_subagent",
    );

    if (finalizeUse) {
      emit({ type: "lead_turn", turn, spawned: 0 });
      break;
    }

    if (ctx.sources.length >= ctx.globalSourceCap) {
      break;
    }

    emit({ type: "lead_turn", turn, spawned: spawnUses.length });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    // Spawn sub-agents in parallel. The runAgenticSubAgent function mutates
    // ctx.sources atomically, so concurrent spawns don't race on n.
    const spawnPromises = spawnUses.map(async (tu) => {
      const input = (tu.input as SpawnSubagentInput) ?? {};
      const sub_question = String(input.sub_question ?? "").trim();
      if (!sub_question) {
        return {
          tu,
          text: "Error: spawn_subagent requires a non-empty `sub_question`.",
        };
      }
      subQuestions.push(sub_question);
      try {
        const result = await runAgenticSubAgent({
          ctx,
          brief: query,
          sub_question,
          agent_source_cap: subagentSourceCap,
          max_tool_calls: maxSubagentToolCalls,
        });
        agentRuns.push({
          sub_question,
          source_ns: result.source_ns,
          tool_calls: result.tool_calls,
          finish_reason: result.finish_reason,
        });
        const added = result.source_ns;
        const header =
          `Scout for "${sub_question}" ` +
          (added.length === 0
            ? `finished with no new sources`
            : `added ${added.length} source${added.length === 1 ? "" : "s"}`) +
          ` (tool calls: ${result.tool_calls}, reason: ${result.finish_reason})`;
        const body = added
          .map((n) => {
            const s = ctx.sources.find((x) => x.n === n);
            if (!s) return `  [${n}] (missing)`;
            return `  [${n}] ${s.title} — ${s.url} (${s.sub_question})`;
          })
          .join("\n");
        const pool = `Pool: ${ctx.sources.length}/${ctx.globalSourceCap}.`;
        return {
          tu,
          text: body ? `${header}:\n${body}\n${pool}` : `${header}. ${pool}`,
        };
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") throw err;
        const message = err instanceof Error ? err.message : String(err);
        agentRuns.push({
          sub_question,
          source_ns: [],
          tool_calls: 0,
          finish_reason: `error: ${message}`,
        });
        return {
          tu,
          text: `Scout for "${sub_question}" errored: ${message}`,
        };
      }
    });

    const spawnResults = await Promise.all(spawnPromises);
    for (const { tu, text } of spawnResults) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: text,
      });
    }

    for (const tu of unknownUses) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: `Unknown tool: ${tu.name}`,
        is_error: true,
      });
    }

    messages.push({ role: "user", content: toolResults });

    if (ctx.sources.length >= ctx.globalSourceCap) {
      break;
    }
  }

  return {
    sub_questions: Array.from(new Set(subQuestions)),
    agent_runs: agentRuns,
    turns: turn,
  };
}

/**
 * Wrap `client.messages.create` so every call's `usage` is accumulated into
 * the returned summary object.
 */
function instrumentAnthropic(client: Anthropic): UsageSummary {
  const usage: UsageSummary = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const origCreate = client.messages.create.bind(client.messages);
  const wrapped = async (
    ...args: Parameters<typeof origCreate>
  ): Promise<Awaited<ReturnType<typeof origCreate>>> => {
    const res = await origCreate(...args);
    if (res && typeof res === "object" && "usage" in res && res.usage) {
      const u = res.usage;
      usage.input_tokens += u.input_tokens ?? 0;
      usage.output_tokens += u.output_tokens ?? 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    }
    return res;
  };
  client.messages.create = wrapped as typeof client.messages.create;
  return usage;
}

