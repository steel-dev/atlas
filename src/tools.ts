import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
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
import { NON_EVIDENCE_WARNINGS } from "./sources.js";
import type { SourceDocument } from "./sources.js";
import { fetchThroughChain, looksBlockedPage } from "./providers/fetch.js";
import {
  openUrlsOf,
  type MergedSearchResult,
  type ResolvedSearch,
} from "./providers/search.js";
import { ROLE_CAPABILITIES } from "./roles.js";
import { addSlot, findSlot, stripGuessedValues } from "./checklist.js";
import { canonicalQuery } from "./search-normalize.js";
import {
  budgetStatusLine,
  type RunCtx,
  type SearchCacheEntry,
  type SourceStore,
  type SurfacedCandidate,
} from "./state.js";
import { currentFrame, type SpanStatus } from "./trace.js";
import type { ToolContext } from "./custom-tools.js";
import { normalizeUrlForSource } from "./url.js";

export const BUILTIN_TOOL_NAMES = [
  "search",
  "fetch",
  "read_source",
  "search_sources",
  "run_code",
  "note",
] as const;

export const LEDGER_TOOL_NAMES = [
  "close_slot",
  "add_slot",
  "retarget_slot",
] as const;

export type ToolName =
  | (typeof BUILTIN_TOOL_NAMES)[number]
  | (typeof LEDGER_TOOL_NAMES)[number];

export interface AgentCtx {
  agentId: string;
  role: AgentRole;
  grant: BudgetGrant;
  depth: number;
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

const SEARCH_SOURCE_HINTS: Record<string, string> = {
  web: "general web pages — the default",
  academic:
    "peer-reviewed papers and preprints (full text or abstract) with citations",
  finance: "company filings and regulatory disclosures (e.g. SEC EDGAR)",
  medical: "biomedical and clinical literature (e.g. PubMed)",
  news: "recent news and journalism",
};

function recordToolSpan(
  rctx: RunCtx,
  kind: "tool" | "io",
  site: string,
  t0: number,
  status: SpanStatus,
  attrs?: Record<string, unknown>,
): void {
  const recorder = rctx.recorder;
  if (!recorder) return;
  const frame = currentFrame();
  recorder.recordToolSpan({
    kind,
    site,
    ...(frame?.agentId ? { agentId: frame.agentId } : {}),
    ...(frame?.parentSpanId ? { parentId: frame.parentSpanId } : {}),
    t0,
    t1: recorder.now(),
    waitMs: 0,
    status,
    ...(attrs ? { attrs } : {}),
  });
}

function withBudgetLine(rctx: RunCtx, actx: AgentCtx, content: string): string {
  if (!ROLE_CAPABILITIES[actx.role].budgetLine) return content;
  return `${content}\n\n[${budgetStatusLine(rctx)}]`;
}

const OPEN_SLOTS_FOOTER_MAX = 6;

function withOpenSlots(rctx: RunCtx, actx: AgentCtx, content: string): string {
  if (actx.role !== "gather") return content;
  const ledger = rctx.ledger;
  if (!ledger) return content;
  const open = ledger.slots.filter((slot) => !slot.fill);
  if (open.length === 0) return content;
  const central = open.filter((slot) => slot.importance === "central");
  const pick = (central.length ? central : open).slice(0, OPEN_SLOTS_FOOTER_MAX);
  const lines = pick
    .map((slot) => `${slot.id} (${slot.shape}): ${slot.ask}`)
    .join("; ");
  const more =
    open.length > pick.length ? ` (+${open.length - pick.length} more open)` : "";
  return `${content}\n\n[open slots — if what you just retrieved grounds any of these, close it now with close_slot(slot_id, value, source_id, quote): ${lines}${more}]`;
}

const COVERAGE_MIN_SEARCHES = 3;
const COVERAGE_FOOTER_MAX_SEARCHES = 24;
const COVERAGE_FOOTER_MAX_DEAD_ENDS = 12;
const COVERAGE_GUIDANCE =
  "do not repeat them; a vein that keeps coming back with little is exhausted — record that fact as unestablished and move on, rather than re-phrasing the same search";

function withSearchCoverage(rctx: RunCtx, content: string): string {
  if (rctx.trail.searchCount < COVERAGE_MIN_SEARCHES) return content;
  const coverage = rctx.trail.render({
    maxSearches: COVERAGE_FOOTER_MAX_SEARCHES,
    maxDeadEnds: COVERAGE_FOOTER_MAX_DEAD_ENDS,
    guidance: COVERAGE_GUIDANCE,
  });
  return coverage ? `${content}\n\n${coverage}` : content;
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

function liveSearch(
  rctx: RunCtx,
  resolved: ResolvedSearch,
  sourceKey: string,
  query: string,
  limit: number,
): Promise<SearchCacheEntry> {
  const key = `${sourceKey}::${canonicalQuery(query)}`;
  const existing = rctx.sources.searchCache.get(key);
  if (existing) {
    rctx.counters.searchCacheHits++;
    return existing;
  }
  const pending = (async () => {
    try {
      return await rctx.ioGate.run(() =>
        withTimeout(SEARCH_TIMEOUT_MS, rctx.signal, "search", (signal) =>
          resolved.run({ query, maxResults: limit, signal }),
        ),
      );
    } catch (err) {
      rctx.sources.searchCache.delete(key);
      throw err;
    }
  })();
  rctx.sources.searchCache.set(key, pending);
  return pending;
}

const AUTHORITY_TIER_A = 1.3;
const AUTHORITY_TIER_B = 1.12;

export function authorityMultiplier(url: string): number {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 1;
  }
  const tierA =
    /(?:^|\.)(?:gov|mil|int)(?:\.[a-z]{2})?$/.test(host) ||
    host.endsWith(".edu") ||
    host.endsWith(".ac.uk") ||
    host === "europa.eu" ||
    host.endsWith(".europa.eu") ||
    host.endsWith("ncbi.nlm.nih.gov") ||
    host === "who.int" ||
    host.endsWith(".who.int") ||
    host === "doi.org" ||
    host === "arxiv.org" ||
    host === "iso.org" ||
    host === "ietf.org" ||
    host === "rfc-editor.org" ||
    host === "w3.org" ||
    host.endsWith(".w3.org");
  if (tierA) return AUTHORITY_TIER_A;
  const tierB =
    host.startsWith("docs.") ||
    host.startsWith("developer.") ||
    host.endsWith(".org");
  if (tierB) return AUTHORITY_TIER_B;
  return 1;
}

const SURFACED_CANDIDATE_CAP = 80;

// Retain the URLs a search surfaced to the model but it did not fetch, so a
// later coverage pass can hand the patch step the exact page that closes a
// needsFetch gap instead of forcing it to re-discover the URL (or search an
// empty store). First-writer-wins, FIFO-evicted, insertion-ordered.
function registerSurfacedCandidate(
  rctx: RunCtx,
  result: { url: string; title?: string | undefined; snippet?: string | undefined },
): void {
  const url = result.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return;
  const key = normalizeUrlForSource(url);
  if (rctx.surfacedCandidates.has(key)) return;
  if (rctx.surfacedCandidates.size >= SURFACED_CANDIDATE_CAP) {
    const oldest = rctx.surfacedCandidates.keys().next().value;
    if (oldest !== undefined) rctx.surfacedCandidates.delete(oldest);
  }
  rctx.surfacedCandidates.set(key, {
    url,
    title: result.title?.trim() || url,
    snippet: (result.snippet ?? "").trim().slice(0, 240),
  });
}

// Surfaced-but-unfetched candidates (most recent first — later searches target
// the open gaps), minus anything already fetched or dead-ended.
export function renderUnfetchedCandidates(rctx: RunCtx, max: number): string {
  const out: string[] = [];
  for (const cand of [...rctx.surfacedCandidates.values()].reverse()) {
    if (out.length >= max) break;
    if (rctx.sources.byUrl.has(normalizeUrlForSource(cand.url))) continue;
    if (rctx.trail.isDeadEnd(cand.url)) continue;
    const snippet = cand.snippet ? ` — ${cand.snippet}` : "";
    out.push(`- ${cand.url}  ·  ${cand.title}${snippet}`);
  }
  return out.join("\n");
}

const SEC_FILING_RE =
  /\b(?:10[- ]?k|10[- ]?q|8[- ]?k|13[- ]?[fdg]|s[- ]?1|def\s*14a|edgar|sec\s+filing)\b|sec\.gov/i;

// When the query explicitly names an SEC form or EDGAR, surface the EDGAR
// full-text search endpoint as a fetchable candidate. This is a capability hint,
// not a judgment: it fires only on the model's own explicit SEC intent, and the
// model decides whether to use it. It is the lifeline when no working finance
// search source is configured (edgar() throws without a contact email).
function secEdgarCandidate(query: string): SurfacedCandidate | null {
  const q = query.trim();
  if (!q || !SEC_FILING_RE.test(q)) return null;
  return {
    url: `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}`,
    title: "SEC EDGAR full-text search",
    snippet:
      "EDGAR full-text search (JSON): each hit carries the company CIK, form type, and accession — follow to the filing at sec.gov/Archives/edgar/data/<CIK>/<ACCESSION>/. Refine q if no hit.",
  };
}

export async function execSearchTool(
  rctx: RunCtx,
  queries: string[],
  limit: number,
  source?: string,
): Promise<string> {
  const cleaned = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  if (cleaned.length === 0) {
    return "Error: search requires at least one non-empty query.";
  }
  const resolved =
    (source ? rctx.searchBySource.get(source) : undefined) ?? rctx.search;
  const sourceKey = source && rctx.searchBySource.has(source) ? source : "web";
  const spanStartedAt = rctx.recorder ? rctx.recorder.now() : 0;
  const allWarnings: string[] = [];
  const byUrl = new Map<string, MergedSearchResult>();
  await mapWithConcurrency(cleaned, 4, async (query) => {
    rctx.counters.searches++;
    const ioKey = `search:${sourceKey}:${limit}:${query}`;
    try {
      const replayed = rctx.replay?.take(ioKey) as
        | SearchCacheEntry
        | undefined;
      const { merged, warnings } =
        replayed ?? (await liveSearch(rctx, resolved, sourceKey, query, limit));
      if (!replayed) rctx.journal?.io(ioKey, { merged, warnings });
      allWarnings.push(...warnings);
      const kept = merged.filter((result) => domainAllowed(rctx, result.url));
      rctx.trail.recordSearch(query, kept.length);
      rctx.emit({
        type: "search.completed",
        query,
        provider: kept[0]?.provider ?? resolved.providers[0]?.id ?? "none",
        results: kept.length,
      });
      rctx.emit({
        type: "tool.event",
        tool: "search.candidates",
        data: {
          query,
          urls: kept.slice(0, 12).map((result) => result.url),
        },
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
          if (!existing.meta) {
            if (result.meta) existing.meta = result.meta;
          } else {
            const open = [
              ...new Set([
                ...openUrlsOf(existing.meta),
                ...openUrlsOf(result.meta),
              ]),
            ];
            if (open.length) existing.meta = { ...existing.meta, openUrls: open };
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
    .sort(
      (a, b) =>
        b.score * authorityMultiplier(b.url) -
        a.score * authorityMultiplier(a.url),
    )
    .slice(0, limit);
  for (const result of byUrl.values()) {
    registerOaCandidate(rctx, result);
  }
  for (const result of ranked) {
    registerSurfacedCandidate(rctx, result);
  }
  recordToolSpan(rctx, "io", "search", spanStartedAt, "ok", {
    queries: cleaned.length,
    results: ranked.length,
  });
  const resultEntries: Record<string, unknown>[] = ranked.map(
    (result, index) => ({
      rank: index + 1,
      title: result.title,
      url: result.url,
      ...(result.snippet ? { snippet: result.snippet.slice(0, 500) } : {}),
      providers: result.providers,
    }),
  );
  const sec = secEdgarCandidate(cleaned.join(" "));
  if (sec && !rctx.sources.byUrl.has(normalizeUrlForSource(sec.url))) {
    registerSurfacedCandidate(rctx, sec);
    if (!resultEntries.some((entry) => entry.url === sec.url)) {
      resultEntries.push({
        rank: resultEntries.length + 1,
        title: sec.title,
        url: sec.url,
        snippet: sec.snippet,
        providers: ["sec_edgar"],
      });
    }
  }
  const body = JSON.stringify(
    {
      ...(cleaned.length === 1 ? { query: cleaned[0] } : { queries: cleaned }),
      results: resultEntries,
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
  _actx: AgentCtx,
  document: SourceDocument,
  _goal: string,
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
  const failedAttempts = (document.metadata.attempts ?? []).filter(
    (attempt) => !attempt.ok,
  );
  if (failedAttempts.length > 0) {
    rctx.emit({
      type: "tool.event",
      tool: "fetch.escalated",
      data: {
        url: document.url,
        via: renderedWith,
        failed: failedAttempts.map((attempt) => ({
          method: attempt.method,
          note: attempt.note,
        })),
      },
    });
  }
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
  const hint = rctx.oaCandidates.get(normalized);
  if (hint) {
    const fullText =
      hint.openUrls.length > 0
        ? await resolveOpenAccessText(
            rctx,
            hint.openUrls,
            rctx.signal ?? undefined,
            Math.max(OA_MIN_CHARS, (hint.fallbackText?.length ?? 0) + 200),
          )
        : null;
    const body = (fullText ?? hint.fallbackText ?? "").trim();
    if (body.length >= MIN_SOURCE_MARKDOWN_CHARS) {
      const renderedWith = fullText ? "open-access" : "abstract";
      const title = hint.title?.trim() || url;
      const stored = storeMarkdown(body);
      const metadata = extractionMetadataFromCustomTool({
        markdownChars: stored.markdown.length,
        toolName: renderedWith,
      });
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
        renderedWith,
      } satisfies JournaledFetch);
      registerSourceDocument(rctx, actx, document, goal, renderedWith);
      return document;
    }
  }
  const fetchStartedAt = rctx.recorder ? rctx.recorder.now() : 0;
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
  recordToolSpan(rctx, "io", "fetch", fetchStartedAt, "ok", {
    url,
    sourceId,
    ok: Boolean(outcome.page),
  });
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

async function fetchMarkdown(
  rctx: RunCtx,
  url: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (!domainAllowed(rctx, trimmed)) return null;
  if (rctx.trail.isDeadEnd(trimmed)) return null;
  const guard = await guardUrl(trimmed, {
    policy: rctx.config.safety,
    seenDomains: rctx.seenDomains,
    emit: rctx.emit,
  });
  if (!guard.ok) return null;
  const outcome = await rctx.ioGate.run(() =>
    fetchThroughChain(rctx.fetchChain, {
      url: trimmed,
      ...(signal ? { signal } : {}),
      onRateLimit: (retryAfterSeconds) =>
        rctx.emit({ type: "rate.limited", retryAfterSeconds }),
      guardRedirect: async (target) => {
        const verdict = await guardRedirect(target, rctx.config.safety);
        return verdict.ok
          ? { ok: true }
          : { ok: false, reason: verdict.reason ?? "redirect blocked" };
      },
    }),
  );
  if (!outcome.page) {
    const reason =
      outcome.attempts
        .map((attempt) => `${attempt.method}: ${attempt.note}`)
        .join(" | ") || "no content fetched";
    rctx.trail.recordDeadEnd(trimmed, reason);
    return null;
  }
  const markdown = outcome.page.markdown?.trim() ?? "";
  return markdown.length > 0 ? markdown : null;
}

const OA_MAX_CANDIDATES = 3;
const OA_MIN_CHARS = 800;

function registerOaCandidate(rctx: RunCtx, result: MergedSearchResult): void {
  const meta = result.meta;
  if (!meta) return;
  const openUrls = openUrlsOf(meta);
  const fallbackText =
    typeof meta.fallbackText === "string" && meta.fallbackText.trim()
      ? meta.fallbackText
      : undefined;
  if (openUrls.length === 0 && !fallbackText) return;
  const key = normalizeUrlForSource(result.url);
  if (rctx.oaCandidates.has(key)) return;
  rctx.oaCandidates.set(key, {
    openUrls,
    ...(result.title ? { title: result.title } : {}),
    ...(fallbackText ? { fallbackText } : {}),
  });
}

async function resolveOpenAccessText(
  rctx: RunCtx,
  candidates: string[],
  signal: AbortSignal | undefined,
  minChars: number,
): Promise<string | null> {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = (candidate ?? "").trim();
    if (trimmed && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      urls.push(trimmed);
      if (urls.length >= OA_MAX_CANDIDATES) break;
    }
  }
  if (urls.length === 0) return null;
  const probed = await Promise.all(
    urls.map((url) => fetchMarkdown(rctx, url, signal)),
  );
  let best: string | null = null;
  for (const text of probed) {
    if (
      text &&
      text.length >= minChars &&
      (!best || text.length > best.length)
    ) {
      best = text;
    }
  }
  return best;
}

const BINARY_FETCH_EXT =
  /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|mp4|mov|avi|mkv|webm|mp3|wav|m4a|zip|gz|tgz|tar|rar|7z|exe|dmg|iso|woff2?|ttf)(?:[?#]|$)/i;

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
  if (BINARY_FETCH_EXT.test(url)) {
    return {
      ok: false,
      error: `Error: ${url} is a binary/asset file (image, archive, font, or media) with no extractable text — fetch an HTML page or PDF instead.`,
    };
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
    return { ok: true, card: sourceCardData(existing, previewChars, goal) };
  }
  const deadReason = rctx.trail.isDeadEnd(url);
  if (deadReason) {
    return {
      ok: false,
      error: `Already failed earlier (${deadReason}). Try a different source.`,
    };
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
    return { ok: true, card: sourceCardData(document, previewChars, goal) };
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
): { documents: SourceDocument[]; missing: string[]; fellBackToAll: boolean } {
  const ids = Array.isArray(sourceIds)
    ? [...new Set(sourceIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  if (ids.length === 0) {
    return {
      documents: [...rctx.sources.byUrl.values()],
      missing: [],
      fellBackToAll: false,
    };
  }
  const documents: SourceDocument[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const document = rctx.sources.byId.get(id);
    if (!document) {
      missing.push(id);
      continue;
    }
    documents.push(document);
  }
  if (documents.length === 0) {
    return {
      documents: [...rctx.sources.byUrl.values()],
      missing,
      fellBackToAll: true,
    };
  }
  return { documents, missing, fellBackToAll: false };
}

function scopeMissingNote(missing: string[], fellBackToAll: boolean): string {
  if (missing.length === 0) return "";
  return fellBackToAll
    ? `\n\n[note: none of the requested source_id(s) exist yet (${missing.join(", ")}) — searched all stored sources instead]`
    : `\n\n[note: skipped source_id(s) not found: ${missing.join(", ")} — searched the rest]`;
}

export function addCustomToolSource(
  rctx: RunCtx,
  _actx: AgentCtx,
  opts: { url: string; title?: string; content: string; toolName: string },
): SourceDocument | null {
  const url = String(opts.url ?? "").trim();
  const content = String(opts.content ?? "");
  if (!url) return null;
  const normalized = normalizeUrlForSource(url);
  const existing = rctx.sources.byUrl.get(normalized);
  if (existing) return existing;
  const ioKey = `custom-source:${normalized}`;
  const replayed = rctx.replay?.take(ioKey) as JournaledFetch | undefined;
  if (!replayed && !content.trim()) return null;
  if (!replayed && totalSourceSlots(rctx.sources) >= rctx.config.maxSources) {
    return null;
  }
  const sourceId =
    replayed?.sourceId ?? `source_${rctx.sources.nextSourceNumber++}`;
  const title = replayed?.title ?? (opts.title?.trim() || url);
  const stored = replayed
    ? { markdown: replayed.markdown, originalChars: replayed.originalChars }
    : storeMarkdown(content);
  const metadata =
    replayed?.metadata ??
    extractionMetadataFromCustomTool({
      markdownChars: stored.markdown.length,
      toolName: opts.toolName,
    });
  const document = createSourceDocument(
    url,
    title,
    stored.markdown,
    metadata,
    stored.originalChars,
    sourceId,
    normalized,
  );
  if (!replayed) {
    rctx.journal?.io(ioKey, {
      url,
      sourceId,
      title,
      markdown: document.markdown,
      metadata: document.metadata,
      originalChars: document.originalChars,
      renderedWith: "custom_tool",
    } satisfies JournaledFetch);
  }
  rctx.sources.fetchedSources.push({
    url,
    title,
    sourceId,
    canonicalUrl: document.canonicalUrl,
  });
  rctx.sources.byUrl.set(normalized, document);
  rctx.sources.byId.set(sourceId, document);
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

const collapseWhitespace = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, " ").trim();

function quoteSupported(document: SourceDocument, quote: string): boolean {
  const q = collapseWhitespace(quote);
  if (q.length < 12) return false;
  return collapseWhitespace(document.markdown).includes(q);
}

export function buildAgentTools(
  rctx: RunCtx,
  actx: AgentCtx,
  names: ToolName[],
): ToolSet {
  const tools: ToolSet = {};
  const enabled = new Set(names);

  if (enabled.has("note")) {
    tools.note = tool({
      description:
        "Record a durable note — the extracted VALUE of what you learned (the exact number, name, date, ratio, or relationship), not merely that you searched or fetched something. Raw search/fetch/read results scroll out of view as you work, but your notes stay: this is your working memory, and the writer composes the report from these notes. A note like 'fetched source_7' is useless — write the fact it contains. Write several as you go, right after you learn something, so you never lose a finding or repeat a search.",
      inputSchema: z.object({
        note: z.string().describe("A self-contained finding, figure, relationship, or coverage note — the actual value, not a pointer to a source."),
      }),
      execute: async ({ note }) => {
        const text = String(note).trim();
        if (text) rctx.notes.push(text);
        return `Noted: ${text.slice(0, 80)}`;
      },
    });
  }

  if (enabled.has("close_slot") && rctx.ledger) {
    const ledger = rctx.ledger;
    tools.close_slot = tool({
      description:
        "Close a ledger slot — pin its answer so it becomes part of the report. Give the exact `value` the slot asked for, rendered to its shape (a band for range, the parts for split, the mechanism for causal, the call for verdict). Two ways to ground it: for a single-source FACT, supply `source_id` + `quote` (an exact span copied verbatim from that fetched source); for a DERIVED or SYNTHESIZED value — a run_code computation, or an analytical/comparative/verdict conclusion you drew across several sources — supply `computed_from` (the source_ids you used) and no quote. Close every central slot, analysis and verdict slots included; a synthesis belongs in a closed slot, not a note.",
      inputSchema: z.object({
        slot_id: z.string(),
        value: z
          .string()
          .describe(
            "The answer to pin — the exact value/finding the slot asked for, rendered to its shape.",
          ),
        source_id: z.string().optional(),
        quote: z
          .string()
          .optional()
          .describe(
            "An exact span copied verbatim from the source (at least a dozen characters) that supports the value — for a single-source fact.",
          ),
        computed_from: z
          .array(z.string())
          .optional()
          .describe(
            "The source_ids you derived or synthesized the value from — a run_code computation, OR an analytical/comparative/verdict conclusion drawn across sources. Use this (no quote needed) to close a derived figure or any analysis, causal, or verdict slot.",
          ),
      }),
      execute: async ({ slot_id, value, source_id, quote, computed_from }) => {
        const slot = findSlot(ledger, slot_id);
        if (!slot) {
          return `Error: unknown slot_id: ${slot_id}. Use add_slot to record a new requirement.`;
        }
        const val = String(value).trim();
        if (!val) return "Error: close_slot requires a non-empty value.";
        if (Array.isArray(computed_from) && computed_from.length > 0) {
          const present = computed_from
            .map((id) => String(id).trim())
            .filter((id) => rctx.sources.byId.has(id));
          if (present.length === 0) {
            return `Error: none of computed_from source_ids are fetched sources: ${computed_from.join(", ")}.`;
          }
          slot.fill = { kind: "computed", value: val, computedFrom: present };
          rctx.emit({
            type: "tool.event",
            tool: "close_slot",
            data: { slot_id: slot.id, kind: "computed" },
          });
          return `Closed ${slot.id} (computed): ${val.slice(0, 80)}`;
        }
        const sid = String(source_id ?? "").trim();
        const document = sid ? rctx.sources.byId.get(sid) : undefined;
        if (!document) {
          return `Error: close_slot needs a valid source_id (a fetched source) plus a supporting quote, or computed_from for a derived value. Unknown source_id: ${sid || "(none)"}.`;
        }
        const q = String(quote ?? "").trim();
        if (!quoteSupported(document, q)) {
          return `Error: that quote was not found verbatim in ${sid}. Copy an exact span (at least a dozen characters) from the source text that states the value — use read_source to get one — or use computed_from for a derived figure.`;
        }
        slot.fill = { kind: "grounded", value: val, quote: q, source: sid };
        rctx.emit({
          type: "tool.event",
          tool: "close_slot",
          data: { slot_id: slot.id, source: sid },
        });
        return `Closed ${slot.id}: ${val.slice(0, 80)} [${sid}]`;
      },
    });
  }

  if (enabled.has("add_slot") && rctx.ledger) {
    const ledger = rctx.ledger;
    tools.add_slot = tool({
      description:
        "Add a slot the plan missed — a requirement the question or the field demands that is not already in the ledger. Phrase the ask value-agnostically (the question to answer, never a guessed answer), then close it with close_slot once grounded.",
      inputSchema: z.object({
        ask: z.string(),
        shape: z.enum(["value", "range", "split", "causal", "matrix", "verdict"]),
        kind: z.enum(["fact", "analysis"]),
        importance: z.enum(["central", "peripheral"]),
        parent: z.string().optional(),
      }),
      execute: async ({ ask, shape, kind, importance, parent }) => {
        const askText = String(ask).trim();
        if (!askText) return "Error: add_slot requires a non-empty ask.";
        const slot = addSlot(ledger, {
          ask: askText,
          shape,
          kind,
          importance,
          ...(parent ? { parent: String(parent).trim() } : {}),
        });
        rctx.emit({
          type: "tool.event",
          tool: "add_slot",
          data: { slot_id: slot.id },
        });
        return `Added ${slot.id} [${slot.importance}·${slot.shape}]: ${slot.ask.slice(0, 80)}`;
      },
    });
  }

  if (enabled.has("retarget_slot") && rctx.ledger) {
    const ledger = rctx.ledger;
    tools.retarget_slot = tool({
      description:
        "Retarget a slot whose ask was mis-aimed — wrong entity, wrong granularity, or the wrong question — to the right one. Use only when the original ask cannot be answered as written; the change is logged and the slot reopens. Give the corrected ask and a one-line reason.",
      inputSchema: z.object({
        slot_id: z.string(),
        new_ask: z.string(),
        reason: z.string(),
      }),
      execute: async ({ slot_id, new_ask, reason }) => {
        const slot = findSlot(ledger, slot_id);
        if (!slot) return `Error: unknown slot_id: ${slot_id}`;
        const before = slot.ask;
        const next = stripGuessedValues(String(new_ask));
        if (!next) return "Error: retarget_slot requires a non-empty new_ask.";
        slot.ask = next;
        slot.fill = null;
        rctx.emit({
          type: "tool.event",
          tool: "retarget_slot",
          data: {
            slot_id: slot.id,
            from: before,
            to: slot.ask,
            reason: String(reason).slice(0, 200),
          },
        });
        return `Retargeted ${slot.id}: "${before.slice(0, 50)}" -> "${slot.ask.slice(0, 50)}"`;
      },
    });
  }

  if (enabled.has("search")) {
    const sourceKeys = [...rctx.searchBySource.keys()];
    const multiSource = sourceKeys.length > 1;
    const baseDescription =
      "Search the web and return a ranked, deduplicated result list with snippets, without fetching anything. `queries` runs up to 4 query variants in parallel and merges the rankings.";
    const description = multiSource
      ? `${baseDescription}\n\nSet \`source\` to target a specialized index instead of the general web:\n` +
        sourceKeys
          .map(
            (key) => `- ${key}: ${SEARCH_SOURCE_HINTS[key] ?? `the ${key} index`}`,
          )
          .join("\n") +
        '\nOmit `source` (or use "web") for general web search.'
      : baseDescription;
    const inputShape = {
      queries: z.array(z.string()).min(1).max(4),
      limit: z.number().int().min(1).max(20).optional(),
    };
    tools.search = tool({
      description,
      inputSchema: multiSource
        ? z.object({
            ...inputShape,
            source: z
              .enum(sourceKeys as [string, ...string[]])
              .optional()
              .describe(
                "Which index to search. Defaults to general web; pick a specialized source when the question targets that domain.",
              ),
          })
        : z.object(inputShape),
      execute: async (input) => {
        const { queries, limit, source } = input as {
          queries: string[];
          limit?: number;
          source?: string;
        };
        return withBudgetLine(
          rctx,
          actx,
          withSearchCoverage(
            rctx,
            await execSearchTool(rctx, queries, limit ?? 8, source),
          ),
        );
      },
    });
  }

  if (enabled.has("fetch")) {
    tools.fetch = tool({
      description:
        "Fetch one or more URLs, store each page's full extracted text as a source document, and return a compact source card per page. For a longer page the card also carries the passages that best match your `goal`, so the fact you came for is in front of you without a second read. Full page text is not returned inline: give a focused `goal` to pull the right passages, then use search_sources and read_source for anything more.",
      inputSchema: z.object({
        url: z.string().optional(),
        urls: z.array(z.string()).min(1).max(FETCH_MANY_MAX_URLS).optional(),
        goal: z
          .string()
          .optional()
          .describe(
            "What you are trying to learn from these pages — ideally the specific figure, name, or fact you need. The card returns the passages that best match it, so a precise goal surfaces the answer inline. Omit to use the overall research question.",
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
        const coerceUrls = (raw: unknown): string[] => {
          if (Array.isArray(raw)) {
            return raw.map((u) => String(u ?? "").trim()).filter(Boolean);
          }
          if (typeof raw === "string") {
            const s = raw.trim();
            if (s.startsWith("[") && s.endsWith("]")) {
              try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) {
                  return parsed.map((u) => String(u ?? "").trim()).filter(Boolean);
                }
              } catch {
                // not a JSON array — treat as a single url below
              }
            }
            return s ? [s] : [];
          }
          return [];
        };
        const targets = [...new Set([...coerceUrls(urls), ...coerceUrls(url)])];
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
        return withOpenSlots(rctx, actx, withBudgetLine(rctx, actx, body));
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
        const { documents, missing, fellBackToAll } = documentsForScope(
          rctx,
          source_ids,
        );
        if (documents.length === 0) {
          return "Error: no fetched source documents are available to search.";
        }
        const body = searchSourceDocuments(documents, query, max_results ?? 10);
        return withOpenSlots(
          rctx,
          actx,
          body + scopeMissingNote(missing, fellBackToAll),
        );
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
        const id = source_id.trim();
        const document = rctx.sources.byId.get(id);
        if (!document) return `Error: unknown source_id: ${id}`;
        const reads = (rctx.readCounts.get(id) ?? 0) + 1;
        rctx.readCounts.set(id, reads);
        const repeat =
          reads >= 3
            ? `\n\n[note: you have read ${id} ${reads} times — its text is stable; pin what you need with note() and rely on that instead of re-reading]`
            : "";
        if (start !== undefined || end !== undefined) {
          return withOpenSlots(
            rctx,
            actx,
            quoteSource(document, start ?? 0, end ?? 0) + repeat,
          );
        }
        return withOpenSlots(
          rctx,
          actx,
          formatSourceChunk(document, chunk_index ?? 0) + repeat,
        );
      },
    });
  }

  if (enabled.has("run_code") && rctx.runCodeEnabled) {
    tools.run_code = tool({
      description:
        "Run JavaScript in an isolated V8 sandbox over the full text of stored sources to extract exact values, compute, or reconcile figures across sources. In scope: `sources` (array of {source_id, url, title, text}), `grep(pattern, {source_ids?, ignore_case?, context?, max?})` → array of {source_id, url, offset, match, text, context} (use `.text` or `.context` for the surrounding window, `.match` for the exact hit), and `print(...)`. The final expression is returned as `result`. No network, filesystem, require, or process access.",
      inputSchema: z.object({
        code: z.string(),
        source_ids: z.array(z.string()).optional(),
        timeout_ms: z.number().int().min(1).max(10_000).optional(),
      }),
      execute: async ({ code, source_ids, timeout_ms }) => {
        if (!code.trim()) return "Error: run_code requires non-empty `code`.";
        const { documents, missing, fellBackToAll } = documentsForScope(
          rctx,
          source_ids,
        );
        if (documents.length === 0) {
          return "Error: no fetched source documents are available to run code over.";
        }
        const codeStartedAt = rctx.recorder ? rctx.recorder.now() : 0;
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
        const content = withOpenSlots(
          rctx,
          actx,
          shapeSandboxOutput(output) + scopeMissingNote(missing, fellBackToAll),
        );
        recordToolSpan(
          rctx,
          "tool",
          "run_code",
          codeStartedAt,
          output.error ? "error" : "ok",
          { output_chars: content.length },
        );
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
          const customStartedAt = rctx.recorder ? rctx.recorder.now() : 0;
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
                  fetchText: (targetUrl) =>
                    fetchMarkdown(rctx, targetUrl, signal),
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
            recordToolSpan(rctx, "tool", custom.name, customStartedAt, "ok", {
              sources_added: sourcesAdded,
            });
            rctx.emit({
              type: "tool.event",
              tool: custom.name,
              data: { sources_added: sourcesAdded },
            });
            return typeof output === "string"
              ? output
              : JSON.stringify(output);
          } catch (err) {
            recordToolSpan(
              rctx,
              "tool",
              custom.name,
              customStartedAt,
              rctx.signal?.aborted ? "aborted" : "error",
            );
            if (rctx.signal?.aborted) throw err;
            return `Tool error: ${errorMessage(err)}`;
          }
        },
      });
    }
  }

  return tools;
}
