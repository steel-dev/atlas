import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { mapWithConcurrency, withTimeout } from "./async.js";
import type { BudgetGrant } from "./budget.js";
import { errorMessage } from "./errors.js";
import type { AgentRole } from "./events.js";
import { guardRedirect, guardUrl, quarantine } from "./safety.js";
import {
  clampSandboxTimeout,
  runCodeSandboxed,
  shapeSandboxOutput,
} from "./sandbox.js";
import {
  createSourceDocument,
  extractionMetadataFromCustomTool,
  formatSourceChunk,
  quoteSource,
  searchSourceDocuments,
  sourceCardData,
  storeMarkdown,
} from "./source-documents.js";
import { NON_EVIDENCE_WARNINGS } from "./ledger.js";
import type { SourceDocument } from "./sources.js";
import { fetchThroughChain, looksBlockedPage } from "./providers/fetch.js";
import type { MergedSearchResult } from "./providers/search.js";
import { ROLE_CAPABILITIES } from "./roles.js";
import { budgetStatusLine, type RunCtx, type SourceStore } from "./state.js";
import type { ToolContext } from "./custom-tools.js";
import { normalizeUrlForSource } from "./url.js";

export const BUILTIN_TOOL_NAMES = [
  "spawn",
  "search",
  "fetch",
  "read_source",
  "search_sources",
  "run_code",
  "ledger",
  "add_claim",
] as const;

export type ToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface SpawnInput {
  role: "research" | "verify";
  task: string;
  budget_fraction?: number | undefined;
  claim_ids?: string[] | undefined;
  lenses?: string[] | undefined;
}

export interface AgentCtx {
  agentId: string;
  role: AgentRole;
  grant: BudgetGrant;
  depth: number;
  spawnsThisStep: { count: number };
  extractModel: LanguageModelV3;
  spawn(input: SpawnInput): Promise<string>;
}

const SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_CUSTOM_TOOL_TIMEOUT_MS = 60_000;
const MAX_CUSTOM_TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_FETCH_PREVIEW_CHARS = 700;
const MAX_FETCH_PREVIEW_CHARS = 2_000;
const FETCH_MANY_MAX_URLS = 12;
const FETCH_CONCURRENCY = 6;
const MIN_SOURCE_MARKDOWN_CHARS = 20;
const THIN_SOURCE_MARKDOWN_CHARS = 300;
const ERROR_TITLE_PATTERN =
  /\b(?:404|not found|access denied|forbidden|error report|captcha|just a moment|sorry)\b/i;
const SEARCH_LISTING_TITLE_PATTERN =
  /\b(?:search results?|advanced search|site search)\b/i;

function withBudgetLine(rctx: RunCtx, actx: AgentCtx, content: string): string {
  if (!ROLE_CAPABILITIES[actx.role].budgetLine) return content;
  return `${content}\n\n[${budgetStatusLine(rctx)}]`;
}

function domainAllowed(rctx: RunCtx, url: string): boolean {
  const filter = rctx.config.sourceFilter;
  if (!filter) return true;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  const matches = (domain: string) => {
    const normalized = domain.replace(/^www\./, "").toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  };
  if (filter.excludeDomains?.some(matches)) return false;
  if (filter.includeDomains && filter.includeDomains.length > 0) {
    return filter.includeDomains.some(matches);
  }
  return true;
}

export async function execSearchTool(
  rctx: RunCtx,
  queries: string[],
  limit: number,
): Promise<string> {
  const cleaned = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  if (cleaned.length === 0) {
    return "Error: search requires at least one non-empty query.";
  }
  const allWarnings: string[] = [];
  const byUrl = new Map<string, MergedSearchResult>();
  await mapWithConcurrency(cleaned, 4, async (query) => {
    rctx.counters.searches++;
    const ioKey = `search:${limit}:${query}`;
    try {
      const cached = rctx.replay?.take(ioKey) as
        | { merged: MergedSearchResult[]; warnings: string[] }
        | undefined;
      const { merged, warnings } =
        cached ??
        (await rctx.ioGate.run(() =>
          withTimeout(SEARCH_TIMEOUT_MS, rctx.signal, "search", (signal) =>
            rctx.search.run({
              query,
              maxResults: limit,
              signal,
            }),
          ),
        ));
      if (!cached) rctx.journal?.io(ioKey, { merged, warnings });
      allWarnings.push(...warnings);
      const kept = merged.filter((result) => domainAllowed(rctx, result.url));
      rctx.trail.recordSearch(query, kept.length);
      rctx.emit({
        type: "search.completed",
        query,
        provider: kept[0]?.provider ?? rctx.search.providers[0]?.id ?? "none",
        results: kept.length,
      });
      for (const result of kept) {
        const key = normalizeUrlForSource(result.url);
        const existing = byUrl.get(key);
        if (!existing) {
          byUrl.set(key, { ...result });
        } else {
          existing.score += result.score;
          for (const provider of result.providers) {
            if (!existing.providers.includes(provider)) {
              existing.providers.push(provider);
            }
          }
        }
      }
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
      const error = errorMessage(err);
      allWarnings.push(`${query}: ${error}`);
      rctx.emit({ type: "search.failed", query, error });
    }
  });
  const ranked = [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const body = JSON.stringify(
    {
      ...(cleaned.length === 1 ? { query: cleaned[0] } : { queries: cleaned }),
      results: ranked.map((result, index) => ({
        rank: index + 1,
        title: result.title,
        url: result.url,
        ...(result.snippet ? { snippet: result.snippet.slice(0, 500) } : {}),
        providers: result.providers,
      })),
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    },
    null,
    2,
  );
  return quarantine(body, { sourceId: "search-results" });
}

function assessSourceQuality(
  markdown: string,
  title: string,
  attempts: { note: string }[],
): { fatalError?: string; warnings: string[] } {
  const trimmed = markdown.trim();
  const warnings: string[] = [];
  if (looksBlockedPage(`${title}\n${trimmed}`)) {
    warnings.push("blocked_or_challenge: fetched content looked blocked");
  }
  if (trimmed.length < MIN_SOURCE_MARKDOWN_CHARS) {
    return {
      fatalError: `thin_content: extracted only ${trimmed.length} chars`,
      warnings,
    };
  }
  const titleLooksLikeError = ERROR_TITLE_PATTERN.test(title);
  const hadHttpError = attempts.some((attempt) =>
    /^http_error:/.test(attempt.note),
  );
  if (titleLooksLikeError && (trimmed.length < 500 || hadHttpError)) {
    warnings.push(`error_page: ${title} (${trimmed.length} chars)`);
  }
  if (trimmed.length < THIN_SOURCE_MARKDOWN_CHARS) {
    warnings.push("thin_content");
  }
  if (SEARCH_LISTING_TITLE_PATTERN.test(title)) {
    warnings.push("search_listing_page");
  }
  return { warnings };
}

function totalSourceSlots(store: SourceStore): number {
  return store.fetchedSources.length + store.reservedSlots;
}

interface JournaledFetch {
  url: string;
  sourceId: string;
  title: string;
  markdown: string;
  metadata: SourceDocument["metadata"];
  originalChars: number;
  renderedWith: string;
}

function registerSourceDocument(
  rctx: RunCtx,
  actx: AgentCtx,
  document: SourceDocument,
  goal: string,
  renderedWith: string,
): void {
  rctx.sources.fetchedSources.push({
    url: document.url,
    title: document.title,
    sourceId: document.sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  rctx.sources.byUrl.set(document.canonicalUrl, document);
  rctx.sources.byId.set(document.sourceId, document);
  if (ROLE_CAPABILITIES[actx.role].ledgerExtract) {
    rctx.ledger.queue(document, {
      goal,
      agentId: actx.agentId,
      model: actx.extractModel,
    });
  }
  const nonEvidence = document.metadata.qualityWarnings?.find((warning) =>
    NON_EVIDENCE_WARNINGS.test(warning),
  );
  if (nonEvidence) rctx.trail.recordDeadEnd(document.url, nonEvidence);
  rctx.counters.sourcesFetched++;
  rctx.emit({
    type: "source.fetched",
    sourceId: document.sourceId,
    url: document.url,
    title: document.title,
    via: renderedWith,
    chars: document.metadata.markdownChars,
    ...(document.metadata.qualityWarnings
      ? { warnings: document.metadata.qualityWarnings }
      : {}),
  });
}

async function fetchSourceDocument(
  rctx: RunCtx,
  actx: AgentCtx,
  url: string,
  sourceId: string,
  goal: string,
): Promise<SourceDocument | null> {
  const normalized = normalizeUrlForSource(url);
  const ioKey = `fetch:${normalized}`;
  const replayed = rctx.replay?.take(ioKey) as JournaledFetch | undefined;
  if (replayed) {
    const document = createSourceDocument(
      replayed.url,
      replayed.title,
      replayed.markdown,
      replayed.metadata,
      replayed.originalChars,
      replayed.sourceId,
      normalized,
    );
    registerSourceDocument(rctx, actx, document, goal, replayed.renderedWith);
    return document;
  }
  const outcome = await rctx.ioGate.run(() =>
    fetchThroughChain(rctx.fetchChain, {
      url,
      ...(rctx.signal ? { signal: rctx.signal } : {}),
      onRateLimit: (retryAfterSeconds) =>
        rctx.emit({ type: "rate.limited", retryAfterSeconds }),
      guardRedirect: async (target) => {
        const verdict = await guardRedirect(target, rctx.config.safety);
        if (verdict.ok) return { ok: true };
        rctx.emit({
          type: "safety.flag",
          kind: verdict.kind,
          detail: `redirect blocked: ${verdict.reason}`,
          url: target,
        });
        return { ok: false, reason: verdict.reason };
      },
    }),
  );
  if (!outcome.page) {
    const reason =
      outcome.attempts
        .map((attempt) => `${attempt.method}: ${attempt.note}`)
        .join(" | ") || "no content fetched";
    rctx.counters.sourcesFailed++;
    rctx.trail.recordDeadEnd(url, reason);
    rctx.emit({ type: "source.failed", url, reason });
    return null;
  }
  const page = outcome.page;
  const title = page.title ?? url;
  const quality = assessSourceQuality(
    page.markdown,
    title,
    outcome.attempts,
  );
  if (quality.fatalError) {
    rctx.counters.sourcesFailed++;
    rctx.trail.recordDeadEnd(url, quality.fatalError);
    rctx.emit({ type: "source.failed", url, reason: quality.fatalError });
    return null;
  }
  const metadata =
    quality.warnings.length === 0
      ? page.metadata
      : {
          ...page.metadata,
          qualityWarnings: [
            ...(page.metadata.qualityWarnings ?? []),
            ...quality.warnings,
          ],
        };
  const stored = storeMarkdown(page.markdown);
  const document = createSourceDocument(
    url,
    title,
    stored.markdown,
    metadata,
    stored.originalChars,
    sourceId,
    normalized,
  );
  rctx.journal?.io(ioKey, {
    url,
    sourceId,
    title,
    markdown: document.markdown,
    metadata: document.metadata,
    originalChars: document.originalChars,
    renderedWith: page.renderedWith,
  } satisfies JournaledFetch);
  registerSourceDocument(rctx, actx, document, goal, page.renderedWith);
  return document;
}

type SingleFetchOutcome =
  | { ok: true; card: Record<string, unknown> }
  | { ok: false; error: string };

export async function fetchOneUrl(
  rctx: RunCtx,
  actx: AgentCtx,
  requestedUrl: string,
  previewChars: number,
  goal: string,
): Promise<SingleFetchOutcome> {
  const url = requestedUrl.trim();
  if (!url) return { ok: false, error: "Error: fetch requires `url`." };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: `Error: not an http(s) URL: ${url}` };
  }
  if (!domainAllowed(rctx, url)) {
    return {
      ok: false,
      error: `Fetch blocked: ${url} is outside the configured source domain filter.`,
    };
  }
  const guard = await guardUrl(url, {
    policy: rctx.config.safety,
    seenDomains: rctx.seenDomains,
    emit: rctx.emit,
  });
  if (!guard.ok) {
    if (guard.kind !== "url-entropy") {
      rctx.emit({
        type: "safety.flag",
        kind: guard.kind,
        detail: guard.reason,
        url,
      });
    }
    return { ok: false, error: `Fetch blocked (${guard.kind}): ${guard.reason}` };
  }

  const normalized = normalizeUrlForSource(url);
  const existing = rctx.sources.byUrl.get(normalized);
  if (existing) {
    return { ok: true, card: sourceCardData(existing, previewChars) };
  }
  rctx.signal?.throwIfAborted();

  let documentPromise = rctx.sources.inFlight.get(normalized);
  if (!documentPromise) {
    if (rctx.sources.reservedUrls.has(normalized)) {
      return {
        ok: false,
        error: `Already being fetched: ${url}. Try another source or continue after this fetch completes.`,
      };
    }
    if (totalSourceSlots(rctx.sources) >= rctx.config.maxSources) {
      return {
        ok: false,
        error: `Fetched source cap reached (${rctx.config.maxSources}). Search or read stored sources, or finish.`,
      };
    }
    rctx.sources.reservedUrls.add(normalized);
    rctx.sources.reservedSlots++;
    const sourceId = `source_${rctx.sources.nextSourceNumber++}`;
    documentPromise = fetchSourceDocument(
      rctx,
      actx,
      url,
      sourceId,
      goal,
    ).finally(() => {
      rctx.sources.inFlight.delete(normalized);
      rctx.sources.reservedUrls.delete(normalized);
      rctx.sources.reservedSlots = Math.max(0, rctx.sources.reservedSlots - 1);
    });
    rctx.sources.inFlight.set(normalized, documentPromise);
  }

  try {
    const document = await documentPromise;
    if (!document) {
      return { ok: false, error: "Fetch failed: no content fetched." };
    }
    return { ok: true, card: sourceCardData(document, previewChars) };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    const message = errorMessage(err);
    rctx.counters.sourcesFailed++;
    rctx.trail.recordDeadEnd(url, message);
    rctx.emit({ type: "source.failed", url, reason: message });
    return { ok: false, error: `Fetch error: ${message}` };
  }
}

function documentsForScope(
  rctx: RunCtx,
  sourceIds: string[] | undefined,
): SourceDocument[] | string {
  const ids = Array.isArray(sourceIds)
    ? [...new Set(sourceIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) return [...rctx.sources.byUrl.values()];
  const documents: SourceDocument[] = [];
  for (const id of ids) {
    const document = rctx.sources.byId.get(id);
    if (!document) return `Error: unknown source_id: ${id}`;
    documents.push(document);
  }
  return documents;
}

export function addCustomToolSource(
  rctx: RunCtx,
  actx: AgentCtx,
  opts: { url: string; title?: string; content: string; toolName: string },
): SourceDocument | null {
  const url = String(opts.url ?? "").trim();
  const content = String(opts.content ?? "");
  if (!url || !content.trim()) return null;
  const normalized = normalizeUrlForSource(url);
  const existing = rctx.sources.byUrl.get(normalized);
  if (existing) return existing;
  if (totalSourceSlots(rctx.sources) >= rctx.config.maxSources) return null;
  const sourceId = `source_${rctx.sources.nextSourceNumber++}`;
  const title = opts.title?.trim() || url;
  const stored = storeMarkdown(content);
  const document = createSourceDocument(
    url,
    title,
    stored.markdown,
    extractionMetadataFromCustomTool({
      markdownChars: stored.markdown.length,
      toolName: opts.toolName,
    }),
    stored.originalChars,
    sourceId,
    normalized,
  );
  rctx.sources.fetchedSources.push({
    url,
    title,
    sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  rctx.sources.byUrl.set(normalized, document);
  rctx.sources.byId.set(sourceId, document);
  rctx.ledger.queue(document, {
    goal: rctx.question,
    agentId: actx.agentId,
    model: actx.extractModel,
  });
  rctx.counters.sourcesFetched++;
  rctx.emit({
    type: "source.fetched",
    sourceId,
    url,
    title,
    via: "custom_tool",
    chars: document.metadata.markdownChars,
  });
  return document;
}

export function buildAgentTools(
  rctx: RunCtx,
  actx: AgentCtx,
  names: ToolName[],
): ToolSet {
  const tools: ToolSet = {};
  const enabled = new Set(names);

  if (enabled.has("spawn")) {
    tools.spawn = tool({
      description:
        "Delegate a self-contained unit of work to a subagent with its own private context and budget slice. " +
        'role "research": the subagent searches, fetches, and extracts verbatim-quoted claims into the shared ledger, then returns a short note. ' +
        'role "verify": independent verifiers adversarially check the given claim_ids and write verdicts to the ledger; claims already settled or currently being verified return their existing verdict instead of spending again. ' +
        "Write `task` as a complete, standalone brief: the objective, what evidence or claims to produce, scope boundaries, and the original research question verbatim. The subagent sees nothing else of your context. " +
        "Multiple spawn calls in one turn run in parallel.",
      inputSchema: z.object({
        role: z.enum(["research", "verify"]),
        task: z
          .string()
          .describe(
            "Self-contained brief for the subagent: objective, expected output, boundaries, and the original question.",
          ),
        budget_fraction: z
          .number()
          .min(0.01)
          .max(1)
          .optional()
          .describe(
            "Fraction of your remaining budget to grant (default 0.15 research, 0.08 verify).",
          ),
        claim_ids: z
          .array(z.string())
          .max(8)
          .optional()
          .describe("For verify spawns: the ledger claim ids to check (max 8)."),
        lenses: z
          .array(
            z.enum(["quote-fidelity", "contradiction", "source-strength"]),
          )
          .optional()
          .describe(
            "For verify spawns: which lenses to apply. Default is staged: non-central claims get a cheap screening check that escalates to the full panel only when flagged; central claims get all three lenses while the grant can fund a panel, and fall back to the screening check when it cannot. A screening pass marks the claim `screened` — only the full panel confirms. Pass lenses explicitly to force the panel; re-verifying a screened claim escalates it to the panel.",
          ),
      }),
      execute: async (input) =>
        withBudgetLine(rctx, actx, await actx.spawn(input as SpawnInput)),
    });
  }

  if (enabled.has("search")) {
    tools.search = tool({
      description:
        "Search the web and return a ranked, deduplicated result list with snippets, without fetching anything. `queries` runs up to 4 query variants in parallel and merges the rankings.",
      inputSchema: z.object({
        queries: z.array(z.string()).min(1).max(4),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      execute: async ({ queries, limit }) =>
        withBudgetLine(
          rctx,
          actx,
          await execSearchTool(rctx, queries, limit ?? 8),
        ),
    });
  }

  if (enabled.has("fetch")) {
    tools.fetch = tool({
      description:
        "Fetch one or more URLs, store each page's full extracted text as a source document" +
        (ROLE_CAPABILITIES[actx.role].ledgerExtract
          ? " (claims are extracted into the shared ledger automatically)"
          : " (for evidence reading only — no claims are extracted from it)") +
        ", and return a compact source card per page. Full page text is not returned inline: use search_sources to find passages and read_source to read or quote them.",
      inputSchema: z.object({
        url: z.string().optional(),
        urls: z.array(z.string()).min(1).max(FETCH_MANY_MAX_URLS).optional(),
        goal: z
          .string()
          .optional()
          .describe(
            "What you are trying to learn from these pages. Claims are extracted against this goal; omit to use the overall research question.",
          ),
        preview_chars: z
          .number()
          .int()
          .min(1)
          .max(MAX_FETCH_PREVIEW_CHARS)
          .optional(),
      }),
      execute: async ({ url, urls, goal, preview_chars }) => {
        const previewChars = Math.min(
          MAX_FETCH_PREVIEW_CHARS,
          Math.max(1, Math.floor(preview_chars ?? DEFAULT_FETCH_PREVIEW_CHARS)),
        );
        const resolvedGoal = goal?.trim() || rctx.question;
        const targets = Array.isArray(urls)
          ? [...new Set(urls.map((u) => String(u ?? "").trim()).filter(Boolean))]
          : url
            ? [url]
            : [];
        if (targets.length === 0) {
          return "Error: fetch requires `url` or a non-empty `urls` array.";
        }
        const outcomes = await mapWithConcurrency(
          targets,
          FETCH_CONCURRENCY,
          async (target) => {
            const outcome = await fetchOneUrl(
              rctx,
              actx,
              target,
              previewChars,
              resolvedGoal,
            );
            return outcome.ok
              ? { url: target, result: outcome.card }
              : { url: target, error: outcome.error };
          },
        );
        const body =
          targets.length === 1
            ? "error" in outcomes[0]
              ? String(outcomes[0].error)
              : JSON.stringify(outcomes[0].result, null, 2)
            : JSON.stringify({ sources: outcomes }, null, 2);
        return withBudgetLine(rctx, actx, body);
      },
    });
  }

  if (enabled.has("ledger")) {
    tools.ledger = tool({
      description:
        "Render the shared claim ledger digest: every representative claim with its id, importance, source quality, verification status, and corroboration count, plus the run's trail of searches already run and fetches that dead-ended. Waits for in-flight claim extraction to finish first, so the digest is current. Use it to judge coverage against the question, pick claim_ids for verify spawns, spot gaps, duplicates, or disagreements, and avoid repeating ground the trail shows was already covered.",
      inputSchema: z.object({
        max_claims: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ max_claims }) => {
        await rctx.ledger.flush();
        const trail = rctx.trail.render({ maxSearches: 30, maxDeadEnds: 15 });
        const trailSuffix = trail ? `\n\n${trail}` : "";
        const representatives = rctx.ledger.representatives();
        if (representatives.length === 0) {
          return withBudgetLine(
            rctx,
            actx,
            `Ledger is empty: no claims extracted yet.${trailSuffix}`,
          );
        }
        const counts = new Map<string, number>();
        for (const claim of representatives) {
          counts.set(claim.status, (counts.get(claim.status) ?? 0) + 1);
        }
        const summary = [...counts.entries()]
          .map(([status, count]) => `${count} ${status}`)
          .join(", ");
        return withBudgetLine(
          rctx,
          actx,
          `${representatives.length} claim(s): ${summary}\n` +
            rctx.ledger.digest(max_claims) +
            trailSuffix,
        );
      },
    });
  }

  if (enabled.has("add_claim")) {
    tools.add_claim = tool({
      description:
        "Mint one claim directly into the shared ledger from a stored source — use it when you pinned an exact value, date, count, or named entity with read_source, search_sources, or run_code that automatic extraction missed or got wrong. `quote` must be copied VERBATIM from the stored source text: it is string-matched, not semantically matched, so never paraphrase, correct, reorder, or splice. The claim enters the same verification machinery as extracted claims.",
      inputSchema: z.object({
        source_id: z.string(),
        claim: z
          .string()
          .describe(
            "Concrete, falsifiable statement preserving exact values, dates, and named entities.",
          ),
        quote: z
          .string()
          .describe(
            "Supporting quote copied verbatim from the stored source text.",
          ),
        importance: z.enum(["central", "supporting", "tangential"]),
      }),
      execute: async ({ source_id, claim, quote, importance }) => {
        const document = rctx.sources.byId.get(source_id.trim());
        if (!document) return `Error: unknown source_id: ${source_id}`;
        const text = claim.trim();
        const quoteText = quote.trim();
        if (!text || !quoteText) {
          return "Error: add_claim requires non-empty `claim` and `quote`.";
        }
        const result = rctx.ledger.addClaim(document, {
          text,
          quote: quoteText,
          importance,
          agentId: actx.agentId,
        });
        switch (result.outcome) {
          case "added":
            return `Added ${result.claim.id} [${result.claim.importance}·${result.claim.sourceQuality}] to the ledger.`;
          case "corroborated":
            return `Already in the ledger as ${result.representativeId}; this source was recorded as corroboration.`;
          case "duplicate":
            return `Already in the ledger as ${result.representativeId} from the same source; nothing added.`;
          case "unsupported":
            return `Rejected: the quote does not appear verbatim in ${source_id}. Read the exact text with read_source and copy it unchanged — the quote is string-matched against the stored source.`;
        }
      },
    });
  }

  if (enabled.has("search_sources")) {
    tools.search_sources = tool({
      description:
        "Keyword-search the source documents already fetched this run and return ranked matching snippets, each with a source_id, chunk_index, and character span you can pass straight to read_source. Restrict with `source_ids` or omit to search every stored source.",
      inputSchema: z.object({
        query: z.string(),
        source_ids: z.array(z.string()).optional(),
        max_results: z.number().int().min(1).max(30).optional(),
      }),
      execute: async ({ query, source_ids, max_results }) => {
        const documents = documentsForScope(rctx, source_ids);
        if (typeof documents === "string") return documents;
        if (documents.length === 0) {
          return "Error: no fetched source documents are available to search.";
        }
        return searchSourceDocuments(documents, query, max_results ?? 10);
      },
    });
  }

  if (enabled.has("read_source")) {
    tools.read_source = tool({
      description:
        "Read exact text from a stored source. Pass `chunk_index` to read a numbered chunk and page through the document (default 0), or `start` and `end` to pull an exact character-span quote.",
      inputSchema: z.object({
        source_id: z.string(),
        chunk_index: z.number().int().min(0).optional(),
        start: z.number().int().min(0).optional(),
        end: z.number().int().min(0).optional(),
      }),
      execute: async ({ source_id, chunk_index, start, end }) => {
        const document = rctx.sources.byId.get(source_id.trim());
        if (!document) return `Error: unknown source_id: ${source_id}`;
        if (start !== undefined || end !== undefined) {
          return quoteSource(document, start ?? 0, end ?? 0);
        }
        return formatSourceChunk(document, chunk_index ?? 0);
      },
    });
  }

  if (enabled.has("run_code")) {
    tools.run_code = tool({
      description:
        "Run JavaScript in an isolated sandbox process over the full text of stored sources to extract exact values, compute, or reconcile figures across sources. In scope: `sources` (array of {source_id, url, title, text}), `grep(pattern, {source_ids?, ignore_case?, context?, max?})`, and `print(...)`. The final expression is returned as `result`. No network, filesystem, require, or process access.",
      inputSchema: z.object({
        code: z.string(),
        source_ids: z.array(z.string()).optional(),
        timeout_ms: z.number().int().min(1).max(10_000).optional(),
      }),
      execute: async ({ code, source_ids, timeout_ms }) => {
        if (!code.trim()) return "Error: run_code requires non-empty `code`.";
        const documents = documentsForScope(rctx, source_ids);
        if (typeof documents === "string") return documents;
        if (documents.length === 0) {
          return "Error: no fetched source documents are available to run code over.";
        }
        const output = await runCodeSandboxed({
          code,
          timeoutMs: clampSandboxTimeout(timeout_ms),
          sources: documents.map((document) => ({
            source_id: document.sourceId,
            url: document.url,
            title: document.title,
            text: document.markdown,
          })),
        });
        const content = shapeSandboxOutput(output);
        rctx.emit({
          type: "tool.event",
          tool: "run_code",
          data: {
            output_chars: content.length,
            ...(output.error ? { error: true } : {}),
          },
        });
        return content;
      },
    });
  }

  if (ROLE_CAPABILITIES[actx.role].customTools) {
    for (const custom of rctx.customTools.values()) {
      tools[custom.name] = tool({
        description: custom.description,
        inputSchema: jsonSchema(custom.inputJsonSchema),
        execute: async (input) => {
          let sourcesAdded = 0;
          const timeoutMs = Math.min(
            MAX_CUSTOM_TOOL_TIMEOUT_MS,
            Math.max(1, custom.timeoutMs ?? DEFAULT_CUSTOM_TOOL_TIMEOUT_MS),
          );
          try {
            const output = await withTimeout(
              timeoutMs,
              rctx.signal,
              custom.name,
              (signal) => {
                const toolCtx: ToolContext = {
                  addSource: (source) => {
                    if (
                      addCustomToolSource(rctx, actx, {
                        ...source,
                        toolName: custom.name,
                      })
                    ) {
                      sourcesAdded++;
                    }
                  },
                  signal,
                  log: (message) =>
                    rctx.emit({
                      type: "tool.event",
                      tool: custom.name,
                      data: String(message),
                    }),
                };
                return Promise.resolve(custom.execute(input, toolCtx));
              },
            );
            rctx.emit({
              type: "tool.event",
              tool: custom.name,
              data: { sources_added: sourcesAdded },
            });
            return typeof output === "string"
              ? output
              : JSON.stringify(output);
          } catch (err) {
            if (rctx.signal?.aborted) throw err;
            return `Tool error: ${errorMessage(err)}`;
          }
        },
      });
    }
  }

  return tools;
}
