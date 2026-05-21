import Anthropic from "@anthropic-ai/sdk";
import {
  WRITER_MODEL,
  parseCitations,
  verifyClaim,
  writeReport,
  type CitedSource,
  type ParsedClaim,
} from "./pipeline.js";
import { type Engine } from "./search.js";
import { createSteel } from "./steel.js";
import { runAgenticSubAgent, type AgentContext } from "./tools.js";

const DEFAULT_MAX_LEAD_TURNS = 8;
const DEFAULT_MAX_SOURCES = 12;
const DEFAULT_MAX_SUBAGENT_TOOL_CALLS = 12;
const DEFAULT_SUBAGENT_SOURCE_CAP = 4;
const PER_DOMAIN_CAP = 2;
const VERIFY_BATCH = 3;

export type { CitedSource, ParsedClaim } from "./pipeline.js";
export type { Engine } from "./search.js";

export interface ClaimVerification {
  claim: string;
  source_n: number;
  source_url: string | null;
  source_title: string | null;
  supported: boolean;
  reason: string;
}

export interface VerificationSummary {
  total: number;
  supported: number;
  unsupported: number;
  pass_rate: number;
}

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
  lead_notes: string;
  lead_turns: number;
  agent_runs: AgentRun[];
  sources: CitedSource[];
  markdown: string;
  verifications: ClaimVerification[];
  verification_summary: VerificationSummary;
  usage_summary: UsageSummary;
}

export type ResearchEvent =
  | { type: "lead_started"; query: string }
  | { type: "lead_turn"; turn: number; spawned: number }
  | { type: "subagent_spawned"; sub_question: string }
  | { type: "lead_finalize"; notes: string; sources_count: number }
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
      type: "summarized";
      sub_question: string;
      url: string;
      n: number;
      summary: string;
    }
  | {
      type: "source_skipped";
      sub_question: string;
      url: string;
      reason: string;
    }
  | { type: "source_error"; sub_question: string; url: string; error: string }
  | { type: "agent_finished"; sub_question: string; sources_added: number }
  | { type: "writing"; sources_count: number }
  | { type: "written"; markdown_chars: number }
  | { type: "verifying"; total: number }
  | {
      type: "verified_claim";
      source_n: number;
      supported: boolean;
      reason: string;
      done: number;
      total: number;
    }
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

interface FinalizeInput {
  notes?: string;
}

const LEAD_TOOLS: Anthropic.Tool[] = [
  {
    name: "spawn_subagent",
    description:
      "Fire one focused scout sub-agent to research a single sub-question. " +
      "The scout has its own search/fetch tools, picks its own queries and backends, and commits high-quality sources to the shared pool. " +
      "Emit multiple spawn_subagent tool_use blocks in a single turn to run scouts IN PARALLEL — much faster than serial. " +
      "Returns: which [n] sources the scout added, a short summary of each, and the scout's finish reason. " +
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
      "Call when the source pool covers the user's question well. The writer phase will start immediately. " +
      "Provide short notes on structure or angles the writer should make sure to address (1-3 sentences).",
    input_schema: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description:
            "Optional 1-3 sentence note to the writer on structure, key findings, or angles to make sure to cover. May be empty.",
        },
      },
      required: [],
    } as Anthropic.Tool["input_schema"],
  },
];

const LEAD_SYSTEM = `You are a research lead. Given a user's research question, you orchestrate a small team of scout sub-agents to gather high-quality sources, then signal when the writer should start.

Tools:
- spawn_subagent(sub_question) — fires a focused scout. Each scout has its own search + fetch tools and adds vetted sources to a shared pool. Emit MULTIPLE spawn_subagent tool_use blocks in ONE turn to run scouts in PARALLEL.
- finalize(notes?) — signals you're done gathering. The writer composes the report from the source pool. Pass short notes on structure or key angles to address.

Strategy:
1. FIRST TURN: decompose the question into 3-5 independent, concrete sub-questions, then call spawn_subagent on all of them IN PARALLEL (emit multiple tool_use blocks at once). Independent = no overlap. Concrete = specific (dates, versions, mechanisms, comparison points), answerable from a few web sources.
2. After scouts return, read what each one found. Look for: missing angles (community signal, primary source, criticism), thin sub-questions (only 1 source), unreconciled contradictions, missing specifics (exact dates / version numbers / benchmark figures).
3. If you find concrete gaps, spawn 1-3 more focused scouts (parallel again, narrow queries — NOT re-statements of round-1 sub-questions). If coverage looks good, call finalize.
4. The shared pool has a global source cap. Once it's near full, scouts return "cap reached" — call finalize.

Be efficient:
- Don't re-spawn for a sub-question that's already well covered.
- Don't ask the same thing as a prior sub-question with different wording.
- Don't speculate about content — only the scouts can actually fetch pages. You orchestrate, they read.
- Most research questions need 1-2 turns total (initial parallel batch + at most one followup). More than 3 turns is usually a sign of poor planning.`;

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  const {
    query,
    anthropicApiKey,
    steelApiKey,
    steelBaseUrl,
    maxSources = DEFAULT_MAX_SOURCES,
    maxLeadTurns = DEFAULT_MAX_LEAD_TURNS,
    maxToolCalls = DEFAULT_MAX_SUBAGENT_TOOL_CALLS,
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

  // Shared source pool. Sub-agents commit atomically via fetch; the lead sees
  // commits via spawn_subagent tool results.
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
    defaultEngine: engine,
    useProxy,
    fastModel,
    perDomainCap: PER_DOMAIN_CAP,
    globalSourceCap: maxSources,
    githubToken,
  };

  // ---- Phase 1: lead orchestration ----
  emit({ type: "lead_started", query });
  const lead = await runLeadAgent({
    anthropic,
    ctx,
    query,
    maxLeadTurns,
    maxSubagentToolCalls: maxToolCalls,
    subagentSourceCap: DEFAULT_SUBAGENT_SOURCE_CAP,
    model: leadModel ?? writerModel ?? WRITER_MODEL,
    emit,
    abort,
  });

  // ---- Phase 2: writer ----
  abort();
  emit({ type: "writing", sources_count: sources.length });
  const { markdown } = await writeReport({
    anthropic,
    query,
    sources,
    source_texts: sourceMarkdowns,
    lead_notes: lead.notes || undefined,
    model: writerModel,
  });
  emit({ type: "written", markdown_chars: markdown.length });

  // ---- Phase 3: verify ----
  abort();
  const claims: ParsedClaim[] = parseCitations(markdown);
  emit({ type: "verifying", total: claims.length });

  const verifications: ClaimVerification[] = [];
  if (claims.length > 0) {
    const sourcesByN = new Map(sources.map((s) => [s.n, s] as const));
    for (let i = 0; i < claims.length; i += VERIFY_BATCH) {
      abort();
      const batch = claims.slice(i, i + VERIFY_BATCH);
      const verdicts = await Promise.all(
        batch.map(async (claim): Promise<ClaimVerification> => {
          const src = sourcesByN.get(claim.source_n);
          if (!src) {
            return {
              claim: claim.text,
              source_n: claim.source_n,
              source_url: null,
              source_title: null,
              supported: false,
              reason: `Source [${claim.source_n}] not found in source list`,
            };
          }
          try {
            const v = await verifyClaim({
              anthropic,
              claim: claim.text,
              source: src,
              raw_text: sourceMarkdowns.get(claim.source_n),
              model: fastModel,
            });
            return {
              claim: claim.text,
              source_n: claim.source_n,
              source_url: src.url,
              source_title: src.title,
              supported: v.supported,
              reason: v.reason,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              claim: claim.text,
              source_n: claim.source_n,
              source_url: src.url,
              source_title: src.title,
              supported: false,
              reason: `verify error: ${message}`,
            };
          }
        }),
      );

      verifications.push(...verdicts);
      for (const v of verdicts) {
        emit({
          type: "verified_claim",
          source_n: v.source_n,
          supported: v.supported,
          reason: v.reason,
          done: verifications.length,
          total: claims.length,
        });
      }
    }
  }

  const total = verifications.length;
  const supported = verifications.filter((v) => v.supported).length;
  const passRate = total > 0 ? supported / total : 1;

  const result: ResearchResult = {
    query,
    sub_questions: lead.sub_questions,
    lead_notes: lead.notes,
    lead_turns: lead.turns,
    agent_runs: lead.agent_runs,
    sources,
    markdown,
    verifications,
    verification_summary: {
      total,
      supported,
      unsupported: total - supported,
      pass_rate: passRate,
    },
    usage_summary: { ...usageSummary },
  };

  emit({ type: "completed", result });
  return result;
}

interface LeadResult {
  sub_questions: string[];
  agent_runs: AgentRun[];
  notes: string;
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
  let notes = "";
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
      resp = await anthropic.messages.create({
        model,
        max_tokens: 2048,
        system: LEAD_SYSTEM,
        tools: LEAD_TOOLS,
        messages,
        // ephemeral cache on last cacheable block; the system prompt + early
        // turns become a reusable prefix as turns accumulate.
        cache_control: { type: "ephemeral" },
      });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw err;
      // Lead-side API error: stop gathering but allow phase 2 to proceed
      // with whatever sources sub-agents already committed.
      notes = `lead error: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Lead stopped emitting tools without finalizing. Treat as implicit
      // finalize so the writer can still run.
      const finalText = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (finalText) notes = finalText;
      break;
    }

    // Separate finalize from spawn_subagent so we can run all spawns in
    // parallel before sending tool_results back.
    const finalizeUse = toolUses.find((tu) => tu.name === "finalize");
    const spawnUses = toolUses.filter((tu) => tu.name === "spawn_subagent");
    const unknownUses = toolUses.filter(
      (tu) => tu.name !== "finalize" && tu.name !== "spawn_subagent",
    );

    emit({ type: "lead_turn", turn, spawned: spawnUses.length });

    // Pre-flight: if the pool is already at cap, skip spawning new scouts.
    const poolFullBeforeSpawn = ctx.sources.length >= ctx.globalSourceCap;

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
      if (poolFullBeforeSpawn) {
        return {
          tu,
          text:
            `Skipped: global source-pool cap (${ctx.globalSourceCap}) reached before this scout could start. ` +
            `Call finalize to start the writer.`,
        };
      }
      subQuestions.push(sub_question);
      emit({ type: "subagent_spawned", sub_question });
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
        return { tu, text: formatScoutResult(sub_question, result, ctx) };
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

    if (finalizeUse) {
      const input = (finalizeUse.input as FinalizeInput) ?? {};
      notes = String(input.notes ?? "").trim();
      toolResults.push({
        type: "tool_result",
        tool_use_id: finalizeUse.id,
        content: "Finalized. Writer phase will begin.",
      });
      messages.push({ role: "user", content: toolResults });
      emit({ type: "lead_finalize", notes, sources_count: ctx.sources.length });
      break;
    }

    messages.push({ role: "user", content: toolResults });

    if (ctx.sources.length >= ctx.globalSourceCap) {
      // Pool is full — lead can't add more sources, force-finalize on next
      // turn by appending a system-style nudge.
      messages.push({
        role: "user",
        content: `Source pool is now at cap (${ctx.sources.length}/${ctx.globalSourceCap}). Call finalize next.`,
      });
    }
  }

  if (!notes && turn >= maxLeadTurns) {
    notes = "(lead exhausted turn budget without explicit finalize)";
  }

  emit({ type: "lead_finalize", notes, sources_count: ctx.sources.length });

  return {
    sub_questions: dedupePreservingOrder(subQuestions),
    agent_runs: agentRuns,
    notes,
    turns: turn,
  };
}

function formatScoutResult(
  sub_question: string,
  result: { source_ns: number[]; tool_calls: number; finish_reason: string },
  ctx: AgentContext,
): string {
  const added = result.source_ns;
  if (added.length === 0) {
    return (
      `Scout for "${sub_question}" finished with no new sources (tool calls: ${result.tool_calls}, reason: ${result.finish_reason}). ` +
      `Pool: ${ctx.sources.length}/${ctx.globalSourceCap}.`
    );
  }
  const lines = added.map((n) => {
    const s = ctx.sources.find((x) => x.n === n);
    if (!s) return `  [${n}] (missing — internal error)`;
    const preview = s.summary.length > 200 ? s.summary.slice(0, 197) + "…" : s.summary;
    return `  [${n}] ${s.title} — ${preview}`;
  });
  return (
    `Scout for "${sub_question}" added ${added.length} source${added.length === 1 ? "" : "s"} ` +
    `(tool calls: ${result.tool_calls}, reason: ${result.finish_reason}):\n` +
    lines.join("\n") +
    `\nPool: ${ctx.sources.length}/${ctx.globalSourceCap}.`
  );
}

function dedupePreservingOrder(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
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

