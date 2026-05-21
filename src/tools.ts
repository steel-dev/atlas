import type Anthropic from "@anthropic-ai/sdk";
import type Steel from "steel-sdk";
import { FAST_MODEL, type CitedSource } from "./pipeline.js";
import {
  arxivSearch,
  githubSearch,
  hnSearch,
  safeDomain,
  webSearch,
  type Backend,
  type Engine,
  type SearchResult,
  type WebSearchOutcome,
} from "./search.js";

const STORED_MARKDOWN_CAP = 50_000;
const FETCH_SNIPPET_CHARS = 2500;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;

export interface SteelGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SourceReservations {
  urls: Set<string>;
  domainCounts: Map<string, number>;
  sourceSlots: number;
}

interface ScrapeCacheEntry {
  markdown: string;
  title: string | null;
}

export interface ResearchCaches {
  serp: Map<string, Promise<WebSearchOutcome>>;
  scrape: Map<string, Promise<ScrapeCacheEntry>>;
}

class Semaphore implements SteelGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) =>
      this.waiting.push(() => {
        this.active++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

export function createSteelGate(limit: number): SteelGate {
  const normalized = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  return new Semaphore(normalized);
}

export function createResearchCaches(): ResearchCaches {
  return {
    serp: new Map<string, Promise<WebSearchOutcome>>(),
    scrape: new Map<string, Promise<ScrapeCacheEntry>>(),
  };
}

export function createSourceReservations(): SourceReservations {
  return {
    urls: new Set<string>(),
    domainCounts: new Map<string, number>(),
    sourceSlots: 0,
  };
}

// ----------------------------------------------------------------------------
// Agentic sub-agent
//
// Each sub-question gets a Haiku-driven loop with two tools:
//   - search(query, source?, site?, limit?)
//   - fetch(url) — scrape + atomic commit to global pool
//
// The scout terminates by emitting a final text message with no tool calls
// (or by hitting its tool/source budget). Every successful fetch commits the
// page to the pool — choose carefully.
//
// Global invariants (URL dedup, per-domain cap, source cap) are enforced
// INSIDE the tools, so the agent can't break them no matter what it picks.
// ----------------------------------------------------------------------------

export interface AgentContext {
  anthropic: Anthropic;
  steel: Steel;
  sources: CitedSource[];
  sourceUrls: Set<string>;
  sourceMarkdowns: Map<number, string>;
  globalDomainCounts: Map<string, number>;
  emit: (e: AgenticEvent) => void;
  abort: () => void;
  /** Forwarded to every Anthropic / Steel / fetch call so cancellation
   *  interrupts in-flight requests, not just step boundaries. */
  signal?: AbortSignal;
  defaultEngine: Engine;
  useProxy: boolean;
  fastModel?: string;
  perDomainCap: number;
  globalSourceCap: number;
  maxConcurrentTools?: number;
  steelGate: SteelGate;
  sourceReservations: SourceReservations;
  caches: ResearchCaches;
  githubToken?: string;
}

// A loose superset of the research event types this module emits. Kept here
// to avoid importing from research.ts (which would create a cycle).
export type AgenticEvent =
  | { type: "agent_started"; sub_question: string }
  | {
      type: "searching";
      sub_question: string;
      index: number;
      query: string;
    }
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
  | { type: "agent_finished"; sub_question: string; sources_added: number };

export interface AgenticRunResult {
  source_ns: number[];
  tool_calls: number;
  finish_reason: string;
}

interface SearchToolInput {
  query?: string;
  source?: Backend;
  site?: string;
  limit?: number;
}
interface FetchToolInput {
  url?: string;
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search for sources addressing the sub-question. Use the `source` parameter to pick a backend:\n" +
      "  • web (default) — general web SERP\n" +
      "  • arxiv — academic papers (best for technical / SOTA / research)\n" +
      "  • github — repositories and code (best for tooling / libraries / implementations)\n" +
      "  • hn — Hacker News discussions (best for community signal, post-mortems, recent commentary)\n" +
      "For targeted web search set `site` (e.g., 'docs.cloudflare.com'). Issue 1-3 searches per agent — don't repeat queries.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Short, search-engine-friendly query (≤10 words ideal).",
        },
        source: {
          type: "string",
          enum: ["web", "arxiv", "github", "hn"],
          description: "Backend. Defaults to web.",
        },
        site: {
          type: "string",
          description:
            "Optional site:foo.com filter; only applied when source=web.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "How many results to return. Default 5.",
        },
      },
      required: ["query"],
    } as Anthropic.Tool["input_schema"],
  },
  {
    name: "fetch",
    description:
      "Fetch a URL, atomically commit it to the global source pool, and return the assigned [n] plus the first chars of the page so you can decide whether to chase citations or pivot. " +
      "Every successful fetch commits — pick the 2-4 most promising results per search, not all of them. Off-topic fetches waste your source budget.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to fetch.",
        },
      },
      required: ["url"],
    } as Anthropic.Tool["input_schema"],
  },
];

const AGENT_SYSTEM = `You're a research scout. Use search and fetch to gather 2-4 high-quality sources for your sub-question, then stop by emitting a text response with no tool calls. Every fetch commits — choose carefully.`;

function reservedDomainCount(ctx: AgentContext, domain: string): number {
  return ctx.sourceReservations.domainCounts.get(domain) ?? 0;
}

function totalDomainCount(ctx: AgentContext, domain: string): number {
  return (ctx.globalDomainCounts.get(domain) ?? 0) + reservedDomainCount(ctx, domain);
}

function totalSourceSlots(ctx: AgentContext): number {
  return ctx.sources.length + ctx.sourceReservations.sourceSlots;
}

function normalizeFetchUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function searchCacheKey(opts: {
  backend: Backend;
  query: string;
  limit: number;
  engine: Engine;
  useProxy: boolean;
  githubToken?: string;
}): string {
  const tokenScope = opts.backend === "github" && opts.githubToken ? "auth" : "anon";
  return [
    opts.backend,
    opts.backend === "web" ? opts.engine : "",
    opts.backend === "web" && opts.useProxy ? "proxy" : "direct",
    tokenScope,
    opts.limit,
    opts.query,
  ].join("\0");
}

interface FetchReservation {
  url: string;
  domain: string;
}

function reserveFetch(ctx: AgentContext, url: string): FetchReservation | string {
  const normalizedUrl = normalizeFetchUrl(url);
  if (ctx.sourceUrls.has(normalizedUrl)) {
    const existing = ctx.sources.find((s) => normalizeFetchUrl(s.url) === normalizedUrl);
    return `Already in source pool as [${existing?.n ?? "?"}]: ${existing?.title ?? url}. Pick a different result.`;
  }
  if (ctx.sourceReservations.urls.has(normalizedUrl)) {
    return `Already being fetched by another scout: ${url}. Pick a different result.`;
  }

  const domain = safeDomain(normalizedUrl);
  if (totalDomainCount(ctx, domain) >= ctx.perDomainCap) {
    return `Domain cap reached for ${domain} (max ${ctx.perDomainCap}). Pick a different source.`;
  }
  if (totalSourceSlots(ctx) >= ctx.globalSourceCap) {
    return `Global source cap reached (${ctx.globalSourceCap}). Stop fetching.`;
  }

  ctx.sourceReservations.urls.add(normalizedUrl);
  ctx.sourceReservations.domainCounts.set(domain, reservedDomainCount(ctx, domain) + 1);
  ctx.sourceReservations.sourceSlots++;
  return { url: normalizedUrl, domain };
}

function releaseFetchReservation(
  ctx: AgentContext,
  reservation: FetchReservation,
): void {
  ctx.sourceReservations.urls.delete(reservation.url);
  const nextDomainCount = reservedDomainCount(ctx, reservation.domain) - 1;
  if (nextDomainCount > 0) {
    ctx.sourceReservations.domainCounts.set(reservation.domain, nextDomainCount);
  } else {
    ctx.sourceReservations.domainCounts.delete(reservation.domain);
  }
  ctx.sourceReservations.sourceSlots = Math.max(
    0,
    ctx.sourceReservations.sourceSlots - 1,
  );
}

async function execSearch(
  args: SearchToolInput,
  ctx: AgentContext,
  subQ: string,
  searchIndex: number,
): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: search requires a non-empty `query`.";

  const backend: Backend = args.source ?? "web";
  const rawLimit = args.limit ?? 5;
  const limit = Math.min(Math.max(1, Math.floor(Number(rawLimit))), 10);

  let effectiveQuery = query;
  if (args.site && backend === "web") {
    const site = String(args.site).trim().replace(/^https?:\/\//, "");
    if (site) effectiveQuery = `${query} site:${site}`;
  }

  ctx.emit({
    type: "searching",
    sub_question: subQ,
    index: searchIndex,
    query: `[${backend}] ${effectiveQuery}`,
  });

  const cacheKey = searchCacheKey({
    backend,
    query: effectiveQuery,
    limit,
    engine: ctx.defaultEngine,
    useProxy: ctx.useProxy,
    githubToken: ctx.githubToken,
  });
  let outcomePromise = ctx.caches.serp.get(cacheKey);
  if (!outcomePromise) {
    outcomePromise = (async () => {
      switch (backend) {
        case "web":
          return await ctx.steelGate.run(() =>
            webSearch({
              steel: ctx.steel,
              query: effectiveQuery,
              engine: ctx.defaultEngine,
              useProxy: ctx.useProxy,
              limit,
              signal: ctx.signal,
            }),
          );
        case "arxiv":
          return await arxivSearch({
            query: effectiveQuery,
            limit,
            signal: ctx.signal,
          });
        case "github":
          return await githubSearch({
            query: effectiveQuery,
            limit,
            token: ctx.githubToken,
            signal: ctx.signal,
          });
        case "hn":
          return await hnSearch({
            query: effectiveQuery,
            limit,
            signal: ctx.signal,
          });
        default: {
          const _exhaustive: never = backend;
          throw new Error(`unknown backend "${_exhaustive}"`);
        }
      }
    })();
    ctx.caches.serp.set(cacheKey, outcomePromise);
  }

  let outcome: WebSearchOutcome;
  try {
    outcome = await outcomePromise;
  } catch (err) {
    ctx.caches.serp.delete(cacheKey);
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({
      type: "search_failed",
      sub_question: subQ,
      index: searchIndex,
      error: message,
    });
    return `Search threw: ${message}`;
  }

  if (!outcome.ok) {
    ctx.emit({
      type: "search_failed",
      sub_question: subQ,
      index: searchIndex,
      error: outcome.error.message,
    });
    return `Search failed (${backend}): ${outcome.error.message}`;
  }

  // Hide results the agent can't usefully fetch (already in pool, domain capped).
  const useful: SearchResult[] = [];
  let filtered = 0;
  for (const r of outcome.results) {
    const normalizedUrl = normalizeFetchUrl(r.url);
    if (
      ctx.sourceUrls.has(normalizedUrl) ||
      ctx.sourceReservations.urls.has(normalizedUrl)
    ) {
      filtered++;
      continue;
    }
    if (totalDomainCount(ctx, r.domain) >= ctx.perDomainCap) {
      filtered++;
      continue;
    }
    if (totalSourceSlots(ctx) >= ctx.globalSourceCap) {
      filtered++;
      continue;
    }
    useful.push(r);
  }

  ctx.emit({
    type: "search_results",
    sub_question: subQ,
    index: searchIndex,
    count: useful.length,
  });

  if (useful.length === 0) {
    return filtered > 0
      ? `No new fetchable results (${filtered} duplicates or domain-capped). Try a different query or backend.`
      : `No results for this query on ${backend}.`;
  }
  const lines = useful.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : ""}`,
  );
  const suffix = filtered > 0 ? `\n\n(${filtered} duplicate/capped results hidden)` : "";
  return `${useful.length} result${useful.length === 1 ? "" : "s"} via ${backend}:\n\n${lines.join("\n\n")}${suffix}`;
}

interface FetchOutcome {
  text: string;
  committed_n?: number;
}

interface ToolExecution {
  toolResult: Anthropic.ToolResultBlockParam;
  committed_n?: number;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(normalizedLimit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function executeToolUse(
  tu: Anthropic.ToolUseBlock,
  ctx: AgentContext,
  subQuestion: string,
  searchIndex?: number,
  skipFetchText?: string,
): Promise<ToolExecution> {
  if (tu.name === "search") {
    try {
      const text = await execSearch(
        (tu.input as SearchToolInput) ?? {},
        ctx,
        subQuestion,
        searchIndex ?? 0,
      );
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: text,
        },
      };
    } catch (err) {
      ctx.abort();
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        },
      };
    }
  }

  if (tu.name === "fetch") {
    if (skipFetchText) {
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: skipFetchText,
        },
      };
    }

    try {
      const out = await execFetch(
        (tu.input as FetchToolInput) ?? {},
        ctx,
        subQuestion,
      );
      return {
        committed_n: out.committed_n,
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: out.text,
        },
      };
    } catch (err) {
      ctx.abort();
      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        },
      };
    }
  }

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: tu.id,
      content: `Unknown tool: ${tu.name}`,
      is_error: true,
    },
  };
}

async function execFetch(
  args: FetchToolInput,
  ctx: AgentContext,
  subQ: string,
): Promise<FetchOutcome> {
  const requestedUrl = String(args.url ?? "").trim();
  if (!requestedUrl) return { text: "Error: fetch requires a `url`." };
  if (!/^https?:\/\//i.test(requestedUrl)) {
    return { text: `Error: not an http(s) URL: ${requestedUrl}` };
  }

  const reservation = reserveFetch(ctx, requestedUrl);
  if (typeof reservation === "string") return { text: reservation };
  const url = reservation.url;

  ctx.emit({ type: "fetching", sub_question: subQ, url });

  try {
    let scrapePromise = ctx.caches.scrape.get(url);
    if (!scrapePromise) {
      scrapePromise = ctx.steelGate
        .run(() =>
          ctx.steel.scrape(
            {
              url,
              format: ["markdown"],
              useProxy: ctx.useProxy,
            },
            { signal: ctx.signal },
          ),
        )
        .then((scrape) => ({
          markdown: scrape.content?.markdown ?? "",
          title: scrape.metadata?.title ?? null,
        }));
      ctx.caches.scrape.set(url, scrapePromise);
    }

    const { markdown, title } = await scrapePromise;
    if (!markdown) {
      ctx.caches.scrape.delete(url);
      ctx.emit({
        type: "source_error",
        sub_question: subQ,
        url,
        error: "Empty markdown",
      });
      return { text: `Empty page (no content fetched).` };
    }

    ctx.abort();

    // Commit while the reservation is still held so source numbers and caps stay
    // consistent across concurrent scouts.
    const n = ctx.sources.length + 1;
    const resolvedTitle = title ?? url;
    ctx.sources.push({
      n,
      url,
      title: resolvedTitle,
      sub_question: subQ,
    });
    ctx.sourceUrls.add(url);
    ctx.sourceMarkdowns.set(n, markdown.slice(0, STORED_MARKDOWN_CAP));
    ctx.globalDomainCounts.set(
      reservation.domain,
      (ctx.globalDomainCounts.get(reservation.domain) ?? 0) + 1,
    );

    ctx.emit({
      type: "source_committed",
      sub_question: subQ,
      url,
      n,
      title: resolvedTitle,
    });

    const snippet = markdown.slice(0, FETCH_SNIPPET_CHARS).trim();
    return {
      committed_n: n,
      text: `Committed [${n}]: ${resolvedTitle}\nURL: ${url}\nFirst ${FETCH_SNIPPET_CHARS} chars:\n${snippet}`,
    };
  } catch (err) {
    ctx.caches.scrape.delete(url);
    const message = err instanceof Error ? err.message : String(err);
    ctx.emit({
      type: "source_error",
      sub_question: subQ,
      url,
      error: message,
    });
    return { text: `Fetch error: ${message}` };
  } finally {
    releaseFetchReservation(ctx, reservation);
  }
}

export async function runAgenticSubAgent(opts: {
  ctx: AgentContext;
  brief: string;
  sub_question: string;
  agent_source_cap: number;
  max_tool_calls?: number;
}): Promise<AgenticRunResult> {
  const { ctx, brief, sub_question, agent_source_cap } = opts;
  const maxToolCalls = opts.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;

  ctx.emit({ type: "agent_started", sub_question });

  const myAddedNs: number[] = [];
  let toolCalls = 0;
  let finishReason = "tool call budget exhausted";
  let searchIndex = 0;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Brief: ${brief}\n\n` +
        `Sub-question: ${sub_question}\n\n` +
        `Budget: at most ${maxToolCalls} tool calls and ${agent_source_cap} sources committed.\n` +
        `Begin.`,
    },
  ];

  while (toolCalls < maxToolCalls && myAddedNs.length < agent_source_cap) {
    ctx.abort();

    let resp: Anthropic.Message;
    try {
      resp = await ctx.anthropic.messages.create(
        {
          model: ctx.fastModel ?? FAST_MODEL,
          max_tokens: 2048,
          system: AGENT_SYSTEM,
          tools: AGENT_TOOLS,
          messages,
          cache_control: { type: "ephemeral" },
        },
        { signal: ctx.signal },
      );
    } catch (err) {
      // SDK abort errors wrap the AbortSignal as APIUserAbortError (name
      // defaults to "Error"), so check the signal directly.
      if (ctx.signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      finishReason = `api error: ${message}`;
      break;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
    );
    if (toolUses.length === 0) {
      finishReason = "scout stopped emitting tools";
      break;
    }

    const remainingToolCalls = maxToolCalls - toolCalls;
    const activeToolUses = toolUses.slice(0, remainingToolCalls);
    const searchIndexes = activeToolUses.map((tu) =>
      tu.name === "search" ? ++searchIndex : undefined,
    );
    let remainingFetchSlots = agent_source_cap - myAddedNs.length;
    const skipFetchTexts = activeToolUses.map((tu) => {
      if (tu.name !== "fetch") return undefined;
      if (remainingFetchSlots > 0) {
        remainingFetchSlots--;
        return undefined;
      }
      return `Agent source cap reached (${agent_source_cap}). Stop fetching.`;
    });
    toolCalls += activeToolUses.length;

    const executions = await mapWithConcurrency(
      activeToolUses,
      ctx.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
      (tu, index) =>
        executeToolUse(
          tu,
          ctx,
          sub_question,
          searchIndexes[index],
          skipFetchTexts[index],
        ),
    );
    const toolResults = executions.map((e) => e.toolResult);
    for (const execution of executions) {
      if (execution.committed_n !== undefined) {
        myAddedNs.push(execution.committed_n);
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (myAddedNs.length >= agent_source_cap) {
      finishReason = "agent source cap reached";
      break;
    }
    if (toolCalls >= maxToolCalls) {
      finishReason = "tool call budget exhausted";
      break;
    }
  }

  ctx.emit({
    type: "agent_finished",
    sub_question,
    sources_added: myAddedNs.length,
  });

  return {
    source_ns: [...myAddedNs],
    tool_calls: toolCalls,
    finish_reason: finishReason,
  };
}
