import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  canonicalKey,
  discoverSitemapCandidates,
  fetchRobotsTxt,
  fetchSitemap,
  filterCandidates,
  normalizeUrl,
  type RobotsRules,
} from "../crawl";
import { extractWithSchema, getAnthropic } from "../llm";
import {
  assessCoverage,
  parseCitations,
  planBriefAndSubQuestions,
  summarizeWebpage,
  verifyClaim,
  writeReport,
  type CitedSource,
  type ParsedClaim,
  type UnsupportedClaim,
} from "../research";
import { webSearch, type Engine, type SearchResult } from "../search";
import { getSteel } from "../steel";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";

const SCHEMA_VERSION = 1;
const STEP_DELAY_MS = 100;
const CRAWL_BATCH_SIZE = 5;
const EXTRACT_BATCH_SIZE = 2;
const VERIFY_BATCH_SIZE = 3;
const MAX_WRITE_ATTEMPTS = 2;
const REQUEST_ID_HEADER = "x-atlas-request-id";
const CRAWL_STATUS_DEFAULT_LIMIT = 10;
const CRAWL_STATUS_MAX_LIMIT = 50;
const CRAWL_PAGE_MARKDOWN_CHAR_LIMIT = 100_000;
// Terminal jobs are reaped 7 days after they finish: SQLite wiped via
// deleteAll(), crawl artifacts deleted from R2. After that, GET on the
// job_id returns 404 (E_JOB_NOT_FOUND).
const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export type AsyncOp = "extract" | "crawl" | "research";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type SubmitResult =
  | { kind: "submitted" | "existing"; state: JobState }
  | { kind: "conflict"; error: string };

export interface ExtractSpec {
  urls: string[];
  schema: Record<string, unknown>;
  prompt?: string;
  use_proxy?: boolean;
}

export interface ResearchSpec {
  query: string;
  max_sub_questions: number;
  max_results_per_question: number;
  max_sources: number;
  max_hops: number;
  verify_threshold: number;
  engine: Engine;
  use_proxy: boolean;
}

export interface CrawlSpec {
  url: string;
  limit: number;
  max_depth?: number;
  max_discovery_depth?: number;
  include_paths: string[];
  exclude_paths: string[];
  crawl_entire_domain: boolean;
  allow_subdomains: boolean;
  allow_external_links: boolean;
  ignore_robots_txt: boolean;
  sitemap: "skip" | "include" | "only";
  deduplicate_similar_urls: boolean;
  ignore_query_parameters: boolean;
  regex_on_full_url: boolean;
  delay?: number;
  use_proxy: boolean;
}

interface FrontierRow {
  [key: string]: SqlStorageValue;
  url: string;
  discovery_depth: number;
}

interface CrawlPageRow {
  [key: string]: SqlStorageValue;
  id: string;
  url: string;
  status: string;
  title: string | null;
  r2_key: string | null;
  status_code: number | null;
  chars: number | null;
  error: string | null;
  discovery_depth: number;
  finished_at: number;
}

interface ClaimVerification {
  claim: string;
  source_n: number;
  source_url: string | null;
  source_title: string | null;
  supported: boolean;
  reason: string;
}

interface AssessmentRecord {
  round: number;
  sufficient: boolean;
  gaps: string[];
  additional_queries: string[];
  reason?: string;
}

interface ResearchInternalState {
  phase: "brief" | "search" | "fetch" | "assess" | "write" | "verify";
  brief?: string;
  sub_questions?: string[];
  current_queries?: string[];
  round?: number;
  assessments?: AssessmentRecord[];
  fetch_queue?: Array<{
    url: string;
    title: string;
    snippet: string;
    sub_question: string;
  }>;
  fetch_idx?: number;
  sources?: CitedSource[];
  report_markdown?: string;
  verify_queue?: ParsedClaim[];
  verify_idx?: number;
  verifications?: ClaimVerification[];
  write_attempt?: number;
  pass_rate_history?: number[];
}

function urlDomain(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

export interface JobState {
  id: string;
  op: AsyncOp;
  status: JobStatus;
  progress: { done: number; total: number };
  error?: string;
  created_at: number;
  finished_at?: number;
}

interface EventRow {
  [key: string]: SqlStorageValue;
  seq: number;
  ts: number;
  event: string;
  data_json: string;
}

interface SourceRow {
  [key: string]: SqlStorageValue;
  url: string;
  title: string | null;
  data_json: string | null;
  citations_json: string | null;
  error: string | null;
  fetched_at: number | null;
}

export class AtlasJob extends DurableObject<Env> {
  private subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this._ensureSchema();
    });
  }

  // ============================================================
  // RPC — called by Worker
  // ============================================================

  async submitExtract(
    jobId: string,
    spec: ExtractSpec,
    bodyHash: string | null,
  ): Promise<SubmitResult> {
    const conflict = this._checkIdempotency(bodyHash);
    if (conflict) return conflict;
    const existing = this._loadState();
    if (existing) return { kind: "existing", state: existing };

    const state: JobState = {
      id: jobId,
      op: "extract",
      status: "queued",
      progress: { done: 0, total: spec.urls.length },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
    if (bodyHash) this._setMeta("body_hash", bodyHash);
    this._appendEvent("submitted", {
      id: jobId,
      op: "extract",
      total: spec.urls.length,
    });

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return { kind: "submitted", state };
  }

  async submitResearch(
    jobId: string,
    spec: ResearchSpec,
    bodyHash: string | null,
  ): Promise<SubmitResult> {
    const conflict = this._checkIdempotency(bodyHash);
    if (conflict) return conflict;
    const existing = this._loadState();
    if (existing) return { kind: "existing", state: existing };

    const state: JobState = {
      id: jobId,
      op: "research",
      status: "queued",
      progress: { done: 0, total: 3 },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
    if (bodyHash) this._setMeta("body_hash", bodyHash);
    this._setMeta(
      "research_state",
      JSON.stringify({ phase: "brief" } satisfies ResearchInternalState),
    );
    this._appendEvent("submitted", {
      id: jobId,
      op: "research",
      query: spec.query,
    });

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return { kind: "submitted", state };
  }

  async submitCrawl(
    jobId: string,
    spec: CrawlSpec,
    bodyHash: string | null,
  ): Promise<SubmitResult> {
    const conflict = this._checkIdempotency(bodyHash);
    if (conflict) return conflict;
    const existing = this._loadState();
    if (existing) return { kind: "existing", state: existing };

    const state: JobState = {
      id: jobId,
      op: "crawl",
      status: "queued",
      progress: { done: 0, total: spec.limit },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
    if (bodyHash) this._setMeta("body_hash", bodyHash);
    this._appendEvent("submitted", {
      id: jobId,
      op: "crawl",
      url: spec.url,
      limit: spec.limit,
    });

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return { kind: "submitted", state };
  }

  // Same idempotency_key + different body → 409. The deterministic DO name
  // already collides retried submits onto this instance, so we only have to
  // detect the mismatch here.
  private _checkIdempotency(bodyHash: string | null): SubmitResult | null {
    if (!bodyHash) return null;
    const stored = this._getMeta("body_hash");
    if (stored && stored !== bodyHash) {
      return {
        kind: "conflict",
        error: "Idempotency-Key reused with a different request body",
      };
    }
    return null;
  }

  // ============================================================
  // HTTP fetch — status / stream / cancel
  // ============================================================

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const lastSeg = url.pathname.split("/").filter(Boolean).at(-1);

    if (request.method === "GET" && lastSeg === "stream") {
      return this._handleStream(request);
    }
    if (request.method === "GET") {
      return this._handleStatus(request);
    }
    if (request.method === "DELETE") {
      return this._handleCancel(request);
    }
    return Response.json(
      envelopeFail(
        ErrorCodes.E_BAD_REQUEST,
        "Method not allowed",
        this._requestId(request),
      ),
      { status: 405 },
    );
  }

  private async _handleStatus(request: Request): Promise<Response> {
    const requestId = this._requestId(request);
    const state = this._loadState();
    if (!state || !this._matchesRequestedOp(state, request)) {
      return Response.json(
        envelopeFail(ErrorCodes.E_JOB_NOT_FOUND, "Job not found", requestId),
        { status: 404 },
      );
    }

    if (state.op === "crawl") {
      return this._handleCrawlStatus(state, request);
    }

    const result =
      state.status === "completed"
        ? this._loadResult()
        : null;

    return Response.json(envelopeOk({ ...state, result }, requestId));
  }

  private async _handleCrawlStatus(state: JobState, request: Request): Promise<Response> {
    const requestId = this._requestId(request);
    const url = new URL(request.url);
    const offsetRaw = url.searchParams.get("offset") ?? "0";
    const limitRaw = url.searchParams.get("limit") ?? String(CRAWL_STATUS_DEFAULT_LIMIT);
    const offset = Math.max(0, parseInt(offsetRaw, 10) || 0);
    const limit = Math.min(
      CRAWL_STATUS_MAX_LIMIT,
      Math.max(1, parseInt(limitRaw, 10) || CRAWL_STATUS_DEFAULT_LIMIT),
    );

    const pageRows = this._loadCrawlPages(offset, limit);
    const totalPages = this._countAllCrawlPages();
    const pages = await Promise.all(pageRows.map((r) => this._buildCrawlPageResponse(r)));

    const hasMore = offset + pages.length < totalPages;
    const result = state.status === "completed" ? this._loadResult() : null;

    return Response.json(
      envelopeOk(
        {
          ...state,
          result,
          summary: {
            completed: this._countCompletedPages(),
            failed: this._countFailedPages(),
            visited_unique: this._countVisited(),
            frontier_remaining: this._countFrontier(),
            pages_total: totalPages,
          },
          pages,
          pagination: {
            offset,
            limit,
            total_pages: totalPages,
            next_offset: hasMore ? offset + pages.length : null,
          },
        },
        requestId,
      ),
    );
  }

  private async _buildCrawlPageResponse(r: CrawlPageRow): Promise<{
    id: string;
    url: string;
    status: string;
    title: string | null;
    markdown: string | null;
    content_truncated: boolean;
    status_code: number | null;
    chars: number | null;
    error: string | null;
    discovery_depth: number;
    finished_at: number;
  }> {
    const { markdown, content_truncated } = await this._loadCrawlMarkdown(r.r2_key);
    return {
      id: r.id,
      url: r.url,
      status: r.status,
      title: r.title,
      markdown,
      content_truncated,
      status_code: r.status_code,
      chars: r.chars,
      error: r.error,
      discovery_depth: r.discovery_depth,
      finished_at: r.finished_at,
    };
  }

  private async _loadCrawlMarkdown(r2Key: string | null): Promise<{
    markdown: string | null;
    content_truncated: boolean;
  }> {
    if (!r2Key) return { markdown: null, content_truncated: false };
    const object = await this.env.ARTIFACTS.get(r2Key);
    if (!object) return { markdown: null, content_truncated: false };
    const markdown = await object.text();
    if (markdown.length <= CRAWL_PAGE_MARKDOWN_CHAR_LIMIT) {
      return { markdown, content_truncated: false };
    }
    return {
      markdown: markdown.slice(0, CRAWL_PAGE_MARKDOWN_CHAR_LIMIT),
      content_truncated: true,
    };
  }

  private _handleStream(request: Request): Response {
    const requestId = this._requestId(request);
    const state = this._loadState();
    if (!state || !this._matchesRequestedOp(state, request)) {
      return Response.json(
        envelopeFail(ErrorCodes.E_JOB_NOT_FOUND, "Job not found", requestId),
        { status: 404 },
      );
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const lastEventIdHeader = request.headers.get("last-event-id");
    const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;

    this._writeReplayAndSubscribe(writer, Number.isFinite(lastEventId) ? lastEventId : 0)
      .catch((err) => {
        console.error("stream replay failed:", err);
        writer.close().catch(() => {});
      });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private async _writeReplayAndSubscribe(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    afterSeq: number,
  ): Promise<void> {
    const events = this._loadEventsAfter(afterSeq);
    for (const e of events) {
      await writer.write(this._encodeSse(e.event, e.data_json, e.seq));
    }

    const state = this._loadState();
    if (
      state &&
      (state.status === "completed" ||
        state.status === "failed" ||
        state.status === "cancelled")
    ) {
      await writer.close();
      return;
    }

    this.subscribers.add(writer);
  }

  private async _handleCancel(request: Request): Promise<Response> {
    const requestId = this._requestId(request);
    const state = this._loadState();
    if (!state || !this._matchesRequestedOp(state, request)) {
      return Response.json(
        envelopeFail(ErrorCodes.E_JOB_NOT_FOUND, "Job not found", requestId),
        { status: 404 },
      );
    }
    if (state.status === "running" || state.status === "queued") {
      state.status = "cancelled";
      state.finished_at = Date.now();
      this._saveState(state);
      await this._emit("cancelled", { reason: "user_request" });
      this._closeAllSubscribers();
      // Replaces the pending step alarm with the +7d cleanup alarm.
      await this._scheduleCleanup();
    }
    return Response.json(envelopeOk(state, requestId));
  }

  private _requestId(request: Request): string {
    return request.headers.get(REQUEST_ID_HEADER) ?? "unknown";
  }

  private _matchesRequestedOp(state: JobState, request: Request): boolean {
    const op = this._requestedOp(request);
    return op === null || op === state.op;
  }

  private _requestedOp(request: Request): AsyncOp | null {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    const op = segments.find((segment): segment is AsyncOp =>
      segment === "extract" || segment === "research" || segment === "crawl"
    );
    return op ?? null;
  }

  // ============================================================
  // Alarm — drives the step loop
  // ============================================================

  override async alarm(): Promise<void> {
    const state = this._loadState();
    if (!state) return;
    if (
      state.status === "cancelled" ||
      state.status === "failed" ||
      state.status === "completed"
    ) {
      // Terminal state alarms are the +7d cleanup tick scheduled by the
      // step that finalized this job.
      await this._cleanup(state);
      return;
    }

    if (state.op === "extract") {
      await this._stepExtract(state);
      return;
    }
    if (state.op === "research") {
      await this._stepResearch(state);
      return;
    }
    if (state.op === "crawl") {
      await this._stepCrawl(state);
      return;
    }

    await this._failJob(state, `Unknown op: ${state.op}`);
  }

  private async _failJob(state: JobState, error: string): Promise<void> {
    state.status = "failed";
    state.error = error;
    state.finished_at = Date.now();
    this._saveState(state);
    await this._emit("failed", { error });
    this._closeAllSubscribers();
    await this._scheduleCleanup();
  }

  private async _scheduleCleanup(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
  }

  private async _cleanup(state: JobState): Promise<void> {
    if (state.op === "crawl") {
      const rows = [
        ...this.sql.exec<{ r2_key: string; [k: string]: SqlStorageValue }>(
          "SELECT r2_key FROM atlas_crawl_pages WHERE r2_key IS NOT NULL",
        ),
      ];
      await Promise.allSettled(
        rows.map((r) => this.env.ARTIFACTS.delete(r.r2_key)),
      );
    }
    // Wipes SQLite + KV + any pending alarm in one shot.
    await this.ctx.storage.deleteAll();
  }

  private _isCancelled(): boolean {
    const s = this._loadState();
    return s?.status === "cancelled";
  }

  private _crawlFilterOpts(
    spec: CrawlSpec,
    robotsRules: RobotsRules | null,
  ): Parameters<typeof filterCandidates>[1] {
    return {
      initialUrl: spec.url,
      maxDepth: spec.max_depth,
      includePaths: spec.include_paths,
      excludePaths: spec.exclude_paths,
      crawlEntireDomain: spec.crawl_entire_domain,
      allowSubdomains: spec.allow_subdomains,
      allowExternalLinks: spec.allow_external_links,
      regexOnFullURL: spec.regex_on_full_url,
      ignoreQueryParameters: spec.ignore_query_parameters,
      robotsRules,
    };
  }

  private async _finishExtract(total: number): Promise<void> {
    const final = this._loadState();
    if (!final || final.status === "cancelled" || final.status === "failed") {
      return;
    }

    const result = this._buildExtractResult();
    this._setMeta("result", JSON.stringify(result));
    final.status = "completed";
    final.progress = { done: total, total };
    final.finished_at = Date.now();
    this._saveState(final);
    await this._emit("completed", { result });
    this._closeAllSubscribers();
    await this._scheduleCleanup();
  }

  private async _stepExtract(state: JobState): Promise<void> {
    const specRaw = this._getMeta("spec");
    if (!specRaw) return this._failJob(state, "Spec missing");
    const spec = JSON.parse(specRaw) as ExtractSpec;
    const useProxy = spec.use_proxy ?? false;
    const total = spec.urls.length;

    if (this._isCancelled()) return;

    state.status = "running";
    state.progress.total = total;
    this._saveState(state);

    let idx = Number(this._getMeta("extract_idx") ?? "0");
    if (!Number.isFinite(idx) || idx < 0) idx = 0;

    if (idx >= total) {
      return this._finishExtract(total);
    }

    const steel = getSteel(this.env);
    const anthropic = getAnthropic(this.env);
    const batchEnd = Math.min(idx + EXTRACT_BATCH_SIZE, total);

    for (let i = idx; i < batchEnd; i++) {
      if (this._isCancelled()) return;

      const url = spec.urls[i];
      const position = i + 1;

      try {
        await this._emit("fetching", { url, position, total });
        const scrape = await steel.scrape({
          url,
          format: ["markdown"],
          useProxy,
        });
        const markdown = scrape.content?.markdown ?? "";
        const title = scrape.metadata?.title ?? null;
        if (!markdown) throw new Error("Steel returned empty markdown");

        if (this._isCancelled()) return;

        await this._emit("extracting", { url });
        const { data, citations } = await extractWithSchema({
          anthropic,
          markdown,
          schema: spec.schema,
          systemPrompt: spec.prompt,
        });

        this._saveSource({ url, title, data, citations });
        await this._emit("extracted", { url, position, data });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this._saveSource({ url, error: message });
        await this._emit("source_error", { url, error: message });
      } finally {
        const cur = this._loadState();
        if (cur && cur.status !== "cancelled") {
          cur.progress.done = position;
          this._saveState(cur);
        }
      }
    }

    idx = batchEnd;
    this._setMeta("extract_idx", String(idx));

    if (this._isCancelled()) return;

    if (idx >= total) {
      return this._finishExtract(total);
    }

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
  }

  private async _stepResearch(state: JobState): Promise<void> {
    state.status = "running";
    this._saveState(state);

    const specRaw = this._getMeta("spec");
    if (!specRaw) return this._failJob(state, "Spec missing");
    const spec = JSON.parse(specRaw) as ResearchSpec;

    const rsRaw = this._getMeta("research_state");
    const rs = rsRaw
      ? (JSON.parse(rsRaw) as ResearchInternalState)
      : { phase: "brief" as const };

    switch (rs.phase) {
      case "brief": {
        try {
          const anthropic = getAnthropic(this.env);
          const plan = await planBriefAndSubQuestions({
            anthropic,
            query: spec.query,
            max_sub_questions: spec.max_sub_questions,
          });
          rs.brief = plan.brief;
          rs.sub_questions = plan.sub_questions;
          rs.current_queries = plan.sub_questions;
          rs.round = 1;
          rs.assessments = [];
          rs.sources = [];
          rs.write_attempt = 1;
          rs.pass_rate_history = [];
          rs.phase = "search";
          this._setMeta("research_state", JSON.stringify(rs));
          state.progress.done = 1;
          this._saveState(state);
          await this._emit("brief", {
            brief: plan.brief,
            sub_questions: plan.sub_questions,
          });
        } catch (err) {
          return this._failJob(
            state,
            `brief: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }

      case "search": {
        const currentQs = rs.current_queries ?? [];
        const round = rs.round ?? 1;
        if (currentQs.length === 0) {
          // Nothing left to search — fall through to assess (which will
          // either accept current sources or end the loop via budget).
          rs.phase = "assess";
          this._setMeta("research_state", JSON.stringify(rs));
          break;
        }

        await this._emit("round_started", { round, queries: currentQs });

        const perQ = await Promise.all(
          currentQs.map(async (q, idx) => {
            await this._emit("searching", { round, idx, query: q });
            const outcome = await webSearch({
              env: this.env,
              query: q,
              engine: spec.engine,
              use_proxy: spec.use_proxy,
              limit: spec.max_results_per_question,
            });
            if (!outcome.ok) {
              await this._emit("search_failed", {
                round,
                idx,
                error: outcome.error.message,
              });
              return [] as Array<SearchResult & { sub_question_idx: number }>;
            }
            await this._emit("search_results", {
              round,
              idx,
              count: outcome.results.length,
            });
            return outcome.results.map((r) => ({ ...r, sub_question_idx: idx }));
          }),
        );

        const flat = perQ.flat();
        const alreadyFetched = new Set((rs.sources ?? []).map((s) => s.url));
        const byUrl = new Map<string, (typeof flat)[number]>();
        for (const r of flat) {
          if (alreadyFetched.has(r.url)) continue;
          if (!byUrl.has(r.url)) byUrl.set(r.url, r);
        }

        // Per-domain cap is global across rounds: seed counts with already-
        // fetched sources so we don't keep returning to the same domain.
        const byDomain = new Map<string, number>();
        for (const s of rs.sources ?? []) {
          const d = urlDomain(s.url);
          if (d) byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
        }

        const remaining = Math.max(
          0,
          spec.max_sources - (rs.sources?.length ?? 0),
        );
        const queue: NonNullable<ResearchInternalState["fetch_queue"]> = [];
        for (const r of byUrl.values()) {
          if (queue.length >= remaining) break;
          const dCount = byDomain.get(r.domain) ?? 0;
          if (dCount >= 2) continue;
          byDomain.set(r.domain, dCount + 1);
          queue.push({
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            sub_question: currentQs[r.sub_question_idx] ?? "",
          });
        }

        rs.fetch_queue = queue;
        rs.fetch_idx = 0;
        if (rs.sources === undefined) rs.sources = [];
        rs.phase = queue.length > 0 ? "fetch" : "assess";
        this._setMeta("research_state", JSON.stringify(rs));

        const fetched = rs.sources.length;
        state.progress.done = 2 + fetched;
        state.progress.total = 2 + fetched + queue.length + 1;
        this._saveState(state);
        break;
      }

      case "fetch": {
        const queue = rs.fetch_queue ?? [];
        const idx = rs.fetch_idx ?? 0;

        if (idx >= queue.length) {
          rs.phase = "assess";
          this._setMeta("research_state", JSON.stringify(rs));
          break;
        }

        const item = queue[idx];
        try {
          await this._emit("fetching", {
            url: item.url,
            position: idx + 1,
            total: queue.length,
          });
          const steel = getSteel(this.env);
          const scrape = await steel.scrape({
            url: item.url,
            format: ["markdown"],
            useProxy: spec.use_proxy,
          });
          const markdown = scrape.content?.markdown ?? "";
          const title = scrape.metadata?.title ?? item.title;
          if (!markdown) throw new Error("Empty markdown from Steel");

          const anthropic = getAnthropic(this.env);
          const summary = await summarizeWebpage({
            anthropic,
            markdown,
            url: item.url,
            title,
            sub_question: item.sub_question,
          });

          if (summary.is_relevant && summary.summary) {
            const n = (rs.sources?.length ?? 0) + 1;
            const source: CitedSource = {
              n,
              url: item.url,
              title,
              summary: summary.summary,
              key_excerpts: summary.key_excerpts,
            };
            rs.sources = [...(rs.sources ?? []), source];
            this._saveSource({
              url: item.url,
              title,
              data: { n, summary: summary.summary, sub_question: item.sub_question },
              citations: summary.key_excerpts.map((q) => ({ quote: q })),
            });
            await this._emit("summarized", {
              url: item.url,
              n,
              position: idx + 1,
              total: queue.length,
              summary: summary.summary,
            });
          } else {
            await this._emit("source_skipped", {
              url: item.url,
              reason: "not relevant",
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this._saveSource({ url: item.url, error: message });
          await this._emit("source_error", { url: item.url, error: message });
        }

        rs.fetch_idx = idx + 1;
        this._setMeta("research_state", JSON.stringify(rs));
        state.progress.done = 2 + (rs.sources?.length ?? 0);
        this._saveState(state);
        break;
      }

      case "assess": {
        if (this._isCancelled()) return;

        const round = rs.round ?? 1;
        const sources = rs.sources ?? [];

        // Budget caps short-circuit the LLM call.
        const hopsUsed = round - 1;
        const reachedHopCap = hopsUsed >= spec.max_hops;
        const reachedSourceCap = sources.length >= spec.max_sources;

        if (spec.max_hops === 0 || reachedHopCap || reachedSourceCap) {
          const reason = reachedSourceCap
            ? "source cap reached"
            : reachedHopCap
              ? "hop cap reached"
              : "single-round mode";
          const record: AssessmentRecord = {
            round,
            sufficient: true,
            gaps: [],
            additional_queries: [],
            reason,
          };
          rs.assessments = [...(rs.assessments ?? []), record];
          rs.phase = "write";
          this._setMeta("research_state", JSON.stringify(rs));
          await this._emit("assessment", record);
          break;
        }

        await this._emit("assessing", {
          round,
          sources_count: sources.length,
        });

        try {
          const anthropic = getAnthropic(this.env);
          const assessment = await assessCoverage({
            anthropic,
            brief: rs.brief ?? "",
            sub_questions: rs.sub_questions ?? [],
            sources,
            rounds_remaining: spec.max_hops - hopsUsed,
            max_additional_queries: 3,
          });

          const goingDeeper =
            !assessment.sufficient && assessment.additional_queries.length > 0;

          const record: AssessmentRecord = {
            round,
            sufficient: !goingDeeper,
            gaps: assessment.gaps,
            additional_queries: assessment.additional_queries,
          };
          rs.assessments = [...(rs.assessments ?? []), record];

          if (goingDeeper) {
            rs.current_queries = assessment.additional_queries;
            rs.round = round + 1;
            rs.phase = "search";
          } else {
            rs.current_queries = [];
            rs.phase = "write";
          }
          this._setMeta("research_state", JSON.stringify(rs));
          await this._emit("assessment", record);
          break;
        } catch (err) {
          // On assess failure, write what we have rather than fail the job.
          const message = err instanceof Error ? err.message : String(err);
          await this._emit("assessment_failed", { round, error: message });
          rs.phase = "write";
          this._setMeta("research_state", JSON.stringify(rs));
          break;
        }
      }

      case "write": {
        try {
          if (this._isCancelled()) return;

          const attempt = rs.write_attempt ?? 1;
          const unsupported: UnsupportedClaim[] | undefined =
            attempt > 1
              ? (rs.verifications ?? [])
                  .filter((v) => !v.supported)
                  .map((v) => ({
                    claim: v.claim,
                    source_n: v.source_n,
                    reason: v.reason,
                  }))
              : undefined;

          await this._emit("writing", {
            attempt,
            sources_count: rs.sources?.length ?? 0,
            unsupported_count: unsupported?.length ?? 0,
          });
          const anthropic = getAnthropic(this.env);

          const report = await writeReport({
            anthropic,
            brief: rs.brief ?? spec.query,
            sources: rs.sources ?? [],
            unsupported_claims: unsupported,
          });

          if (this._isCancelled()) return;

          rs.report_markdown = report.markdown;
          // Reset verify-phase state so the next pass operates on the new draft.
          rs.verify_queue = undefined;
          rs.verify_idx = undefined;
          rs.verifications = [];
          rs.phase = "verify";
          this._setMeta("research_state", JSON.stringify(rs));

          state.progress.done = state.progress.total;
          this._saveState(state);

          await this._emit("written", {
            attempt,
            markdown_chars: report.markdown.length,
          });
          break;
        } catch (err) {
          return this._failJob(
            state,
            `write: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      case "verify": {
        if (this._isCancelled()) return;

        const md = rs.report_markdown;
        if (md === undefined) {
          return this._failJob(state, "verify: report markdown missing");
        }

        // First entry: parse claims and expand progress total.
        if (rs.verify_queue === undefined) {
          const claims = parseCitations(md);
          rs.verify_queue = claims;
          rs.verify_idx = 0;
          rs.verifications = [];
          this._setMeta("research_state", JSON.stringify(rs));

          state.progress.total = state.progress.total + claims.length;
          this._saveState(state);

          await this._emit("verifying", { total: claims.length });

          if (claims.length === 0) {
            return this._finalizeResearch(state, rs, spec);
          }
        }

        const queue = rs.verify_queue;
        const idx = rs.verify_idx ?? 0;
        if (idx >= queue.length) {
          return this._finalizeResearch(state, rs, spec);
        }

        const batchEnd = Math.min(idx + VERIFY_BATCH_SIZE, queue.length);
        const batch = queue.slice(idx, batchEnd);
        const anthropic = getAnthropic(this.env);
        const sourcesByN = new Map(
          (rs.sources ?? []).map((s) => [s.n, s] as const),
        );

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
              const verdict = await verifyClaim({
                anthropic,
                claim: claim.text,
                source: src,
              });
              return {
                claim: claim.text,
                source_n: claim.source_n,
                source_url: src.url,
                source_title: src.title,
                supported: verdict.supported,
                reason: verdict.reason,
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

        if (this._isCancelled()) return;

        rs.verifications = [...(rs.verifications ?? []), ...verdicts];
        rs.verify_idx = batchEnd;
        this._setMeta("research_state", JSON.stringify(rs));

        for (const v of verdicts) {
          await this._emit("verified_claim", {
            source_n: v.source_n,
            supported: v.supported,
            reason: v.reason,
            progress: { done: rs.verifications.length, total: queue.length },
          });
        }

        state.progress.done = state.progress.total - (queue.length - batchEnd);
        this._saveState(state);

        if (batchEnd >= queue.length) {
          return this._finalizeResearch(state, rs, spec);
        }
        break;
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
  }

  private async _finalizeResearch(
    state: JobState,
    rs: ResearchInternalState,
    spec: ResearchSpec,
  ): Promise<void> {
    const verifications = rs.verifications ?? [];
    const total = verifications.length;
    const supported = verifications.filter((v) => v.supported).length;
    const pass_rate = total > 0 ? supported / total : 1;
    const verification_summary = {
      total,
      supported,
      unsupported: total - supported,
      pass_rate,
    };

    const attempt = rs.write_attempt ?? 1;
    const history = [...(rs.pass_rate_history ?? []), pass_rate];
    rs.pass_rate_history = history;

    // Retry one rewrite if pass rate is below threshold and we still have an
    // attempt left. The rewrite reuses sources but feeds the unsupported
    // claims back to the writer.
    const shouldRetry =
      pass_rate < spec.verify_threshold &&
      attempt < MAX_WRITE_ATTEMPTS &&
      total > 0;

    if (shouldRetry) {
      rs.write_attempt = attempt + 1;
      rs.phase = "write";
      this._setMeta("research_state", JSON.stringify(rs));

      // Expand total to account for the upcoming rewrite + re-verify.
      // claims.length is unknown until reparsed, so we bump conservatively;
      // verify init will refine again.
      state.progress.total = state.progress.total + 1;
      this._saveState(state);

      await this._emit("verify_failed", {
        attempt,
        pass_rate,
        threshold: spec.verify_threshold,
        unsupported: total - supported,
        retrying: true,
      });
      await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
      return;
    }

    const result = {
      query: spec.query,
      brief: rs.brief ?? "",
      sub_questions: rs.sub_questions ?? [],
      sources: rs.sources ?? [],
      markdown: rs.report_markdown ?? "",
      assessments: rs.assessments ?? [],
      rounds: rs.round ?? 1,
      attempts: attempt,
      pass_rate_history: history,
      verifications,
      verification_summary,
    };

    this._setMeta("result", JSON.stringify(result));
    state.status = "completed";
    state.progress.done = state.progress.total;
    state.finished_at = Date.now();
    this._saveState(state);
    await this._emit("completed", {
      sources_count: (rs.sources ?? []).length,
      markdown_chars: (rs.report_markdown ?? "").length,
      verification_summary,
      attempts: attempt,
      pass_rate_history: history,
    });
    this._closeAllSubscribers();
    await this._scheduleCleanup();
  }

  private _crawlProcessedCount(): number {
    return this._countCompletedPages() + this._countFailedPages();
  }

  private async _stepCrawl(state: JobState): Promise<void> {
    if (this._isCancelled()) return;

    state.status = "running";
    this._saveState(state);

    const specRaw = this._getMeta("spec");
    if (!specRaw) return this._failJob(state, "Spec missing");
    const spec = JSON.parse(specRaw) as CrawlSpec;

    if (this._getMeta("crawl_kickoff_done") !== "1") {
      await this._emit("started", { url: spec.url, limit: spec.limit });

      if (this._isCancelled()) return;

      let robotsRules: RobotsRules | null = null;
      if (!spec.ignore_robots_txt) {
        robotsRules = await fetchRobotsTxt(spec.url);
        if (robotsRules) this._setMeta("robots_rules", JSON.stringify(robotsRules));
      }

      const filterOpts = this._crawlFilterOpts(spec, robotsRules);

      // sitemap: "only" — seed frontier from sitemap URLs, not the start URL.
      if (spec.sitemap !== "only") {
        const seedNorm = normalizeUrl(spec.url, {
          ignoreQueryParameters: spec.ignore_query_parameters,
        });
        if (seedNorm) {
          const seedKey = spec.deduplicate_similar_urls
            ? canonicalKey(seedNorm)
            : seedNorm;
          this._markVisited(seedKey);
          this._enqueueFrontier(seedNorm, 0);
        }
      }

      if (spec.sitemap !== "skip") {
        const candidates = discoverSitemapCandidates(spec.url, robotsRules);
        const allUrls: string[] = [];
        for (const c of candidates) {
          if (this._isCancelled()) return;
          const urls = await fetchSitemap(c);
          allUrls.push(...urls);
          if (allUrls.length > 5000) break;
        }

        const filtered = filterCandidates(allUrls, filterOpts);

        let enqueued = 0;
        for (const f of filtered) {
          if (enqueued >= spec.limit) break;
          const key = spec.deduplicate_similar_urls ? canonicalKey(f) : f;
          if (this._isVisited(key)) continue;
          this._markVisited(key);
          this._enqueueFrontier(f, 0);
          enqueued++;
        }

        await this._emit("sitemap_loaded", {
          discovered: allUrls.length,
          enqueued,
        });

        if (spec.sitemap === "only") this._setMeta("sitemap_only", "1");
      }

      this._setMeta("crawl_kickoff_done", "1");
      state.progress.total = Math.min(spec.limit, this._countFrontier());
      this._saveState(state);

      if (this._isCancelled()) return;

      await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
      return;
    }

    const processed = this._crawlProcessedCount();
    const remaining = spec.limit - processed;
    if (remaining <= 0) return this._completeCrawl(state, spec, "limit_reached");

    if (this._isCancelled()) return;

    const batch = this._popFrontier(Math.min(CRAWL_BATCH_SIZE, remaining));
    if (batch.length === 0) return this._completeCrawl(state, spec, "frontier_drained");

    const robotsRaw = this._getMeta("robots_rules");
    const robotsRules: RobotsRules | null = robotsRaw
      ? (JSON.parse(robotsRaw) as RobotsRules)
      : null;
    const sitemapOnly = this._getMeta("sitemap_only") === "1";
    const filterOpts = this._crawlFilterOpts(spec, robotsRules);

    await Promise.all(
      batch.map(async (item) => {
        if (this._isCancelled()) return;

        try {
          await this._emit("page_started", {
            url: item.url,
            depth: item.discovery_depth,
          });

          if (this._isCancelled()) return;

          const steel = getSteel(this.env);
          const scrape = await steel.scrape({
            url: item.url,
            format: ["markdown"],
            useProxy: spec.use_proxy,
          });
          const markdown = scrape.content?.markdown ?? "";
          const title = scrape.metadata?.title ?? null;
          const statusCode = scrape.metadata?.statusCode ?? null;

          if (!markdown) throw new Error("Empty markdown from Steel");

          if (this._isCancelled()) return;

          const pageId = crypto.randomUUID();
          const r2Key = `crawl/${state.id}/${pageId}.md`;
          await this.env.ARTIFACTS.put(r2Key, markdown);

          this._saveCrawlPage({
            id: pageId,
            url: item.url,
            status: "success",
            title,
            r2_key: r2Key,
            status_code: statusCode,
            chars: markdown.length,
            discovery_depth: item.discovery_depth,
          });

          const withinDiscoveryDepth =
            spec.max_discovery_depth === undefined ||
            item.discovery_depth < spec.max_discovery_depth;

          if (!sitemapOnly && withinDiscoveryDepth && !this._isCancelled()) {
            const candidates: string[] = [];
            for (const l of scrape.links ?? []) {
              if (l.url) candidates.push(l.url);
            }
            const filtered = filterCandidates(candidates, filterOpts);

            let added = 0;
            for (const f of filtered) {
              if (this._countVisited() + added >= spec.limit) break;
              const key = spec.deduplicate_similar_urls ? canonicalKey(f) : f;
              if (this._isVisited(key)) continue;
              this._markVisited(key);
              this._enqueueFrontier(f, item.discovery_depth + 1);
              added++;
            }
          }

          await this._emit("page", {
            url: item.url,
            completed: this._countCompletedPages(),
            total: spec.limit,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this._saveCrawlPage({
            id: crypto.randomUUID(),
            url: item.url,
            status: "failed",
            title: null,
            r2_key: null,
            status_code: null,
            chars: null,
            error: message,
            discovery_depth: item.discovery_depth,
          });
          await this._emit("page_failed", { url: item.url, error: message });
        }
      }),
    );

    if (this._isCancelled()) return;

    const cur = this._loadState();
    if (!cur || cur.status === "cancelled") return;

    cur.progress.done = this._crawlProcessedCount();
    cur.progress.total = Math.min(spec.limit, this._countVisited());
    this._saveState(cur);

    const delay = spec.delay ?? 0;
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(STEP_DELAY_MS, delay),
    );
  }

  private async _completeCrawl(
    state: JobState,
    spec: CrawlSpec,
    reason: string,
  ): Promise<void> {
    const completed = this._countCompletedPages();
    const failed = this._countFailedPages();
    const visited = this._countVisited();
    const processed = completed + failed;

    state.status = "completed";
    state.finished_at = Date.now();
    state.progress.done = processed;
    state.progress.total = processed;
    this._saveState(state);

    const result = {
      origin_url: spec.url,
      completed,
      failed,
      visited,
      stopped_reason: reason,
    };
    this._setMeta("result", JSON.stringify(result));

    await this._emit("completed", result);
    this._closeAllSubscribers();
    await this._scheduleCleanup();
  }

  // ============================================================
  // SQLite schema + accessors
  // ============================================================

  private get sql() {
    return this.ctx.storage.sql;
  }

  private _ensureSchema(): void {
    const tableExists = [
      ...this.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='atlas_meta'",
      ),
    ].length > 0;

    let currentVersion = 0;
    if (tableExists) {
      const row = [
        ...this.sql.exec<{ value: string }>(
          "SELECT value FROM atlas_meta WHERE key='schema_version'",
        ),
      ][0];
      currentVersion = row ? Number(row.value) : 0;
    }
    if (currentVersion >= SCHEMA_VERSION) return;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_sources (
        url TEXT PRIMARY KEY,
        title TEXT,
        data_json TEXT,
        citations_json TEXT,
        error TEXT,
        fetched_at INTEGER
      );
    `);

    // --- v2 crawl tables ---
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_crawl_frontier (
        url TEXT PRIMARY KEY,
        discovery_depth INTEGER NOT NULL,
        enqueued_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_atlas_crawl_frontier_order ON atlas_crawl_frontier(enqueued_at, discovery_depth)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_crawl_visited (
        perm_key TEXT PRIMARY KEY
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_crawl_pages (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        r2_key TEXT,
        status_code INTEGER,
        chars INTEGER,
        error TEXT,
        discovery_depth INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_atlas_crawl_pages_status ON atlas_crawl_pages(status)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_atlas_crawl_pages_finished ON atlas_crawl_pages(finished_at)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS atlas_crawl_robots_blocked (
        url TEXT PRIMARY KEY
      );
    `);

    this.sql.exec(
      "INSERT OR REPLACE INTO atlas_meta(key, value) VALUES('schema_version', ?)",
      String(SCHEMA_VERSION),
    );
  }

  private _loadState(): JobState | null {
    const rows = [
      ...this.sql.exec<{ state_json: string }>(
        "SELECT state_json FROM atlas_state WHERE id=1",
      ),
    ];
    return rows[0] ? (JSON.parse(rows[0].state_json) as JobState) : null;
  }

  private _saveState(state: JobState): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO atlas_state(id, state_json) VALUES(1, ?)",
      JSON.stringify(state),
    );
  }

  private _getMeta(key: string): string | null {
    const rows = [
      ...this.sql.exec<{ value: string }>(
        "SELECT value FROM atlas_meta WHERE key=?",
        key,
      ),
    ];
    return rows[0]?.value ?? null;
  }

  private _setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO atlas_meta(key, value) VALUES(?, ?)",
      key,
      value,
    );
  }

  private _loadResult(): unknown {
    const raw = this._getMeta("result");
    return raw ? JSON.parse(raw) : null;
  }

  private _appendEvent(event: string, data: unknown): { seq: number; ts: number } {
    const ts = Date.now();
    const rows = [
      ...this.sql.exec<{ seq: number }>(
        "INSERT INTO atlas_events(ts, event, data_json) VALUES(?, ?, ?) RETURNING seq",
        ts,
        event,
        JSON.stringify(data),
      ),
    ];
    return { seq: rows[0].seq, ts };
  }

  private _loadEventsAfter(seq: number): EventRow[] {
    return [
      ...this.sql.exec<EventRow>(
        "SELECT seq, ts, event, data_json FROM atlas_events WHERE seq > ? ORDER BY seq",
        seq,
      ),
    ];
  }

  private _saveSource(s: {
    url: string;
    title?: string | null;
    data?: unknown;
    citations?: unknown;
    error?: string;
  }): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO atlas_sources(url, title, data_json, citations_json, error, fetched_at) VALUES(?, ?, ?, ?, ?, ?)",
      s.url,
      s.title ?? null,
      s.data !== undefined ? JSON.stringify(s.data) : null,
      s.citations !== undefined ? JSON.stringify(s.citations) : null,
      s.error ?? null,
      Date.now(),
    );
  }

  private _buildExtractResult(): { sources: Array<unknown> } {
    const rows = [
      ...this.sql.exec<SourceRow>(
        "SELECT url, title, data_json, citations_json, error, fetched_at FROM atlas_sources",
      ),
    ];
    const sources = rows.map((r) => ({
      url: r.url,
      title: r.title,
      data: r.data_json ? JSON.parse(r.data_json) : null,
      citations: r.citations_json ? JSON.parse(r.citations_json) : [],
      error: r.error,
      fetched_at: r.fetched_at,
    }));
    return { sources };
  }

  // ---- crawl SQL helpers ----

  private _enqueueFrontier(url: string, depth: number): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO atlas_crawl_frontier(url, discovery_depth, enqueued_at) VALUES(?, ?, ?)",
      url,
      depth,
      Date.now(),
    );
  }

  private _popFrontier(n: number): Array<{ url: string; discovery_depth: number }> {
    const rows = [
      ...this.sql.exec<FrontierRow>(
        "SELECT url, discovery_depth FROM atlas_crawl_frontier ORDER BY enqueued_at, discovery_depth LIMIT ?",
        n,
      ),
    ];
    for (const r of rows) {
      this.sql.exec("DELETE FROM atlas_crawl_frontier WHERE url = ?", r.url);
    }
    return rows.map((r) => ({ url: r.url, discovery_depth: r.discovery_depth }));
  }

  private _countFrontier(): number {
    const row = [
      ...this.sql.exec<{ c: number; [k: string]: SqlStorageValue }>(
        "SELECT COUNT(*) as c FROM atlas_crawl_frontier",
      ),
    ][0];
    return row?.c ?? 0;
  }

  private _markVisited(key: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO atlas_crawl_visited(perm_key) VALUES(?)",
      key,
    );
  }

  private _isVisited(key: string): boolean {
    const rows = [
      ...this.sql.exec<{ perm_key: string; [k: string]: SqlStorageValue }>(
        "SELECT perm_key FROM atlas_crawl_visited WHERE perm_key = ? LIMIT 1",
        key,
      ),
    ];
    return rows.length > 0;
  }

  private _countVisited(): number {
    const row = [
      ...this.sql.exec<{ c: number; [k: string]: SqlStorageValue }>(
        "SELECT COUNT(*) as c FROM atlas_crawl_visited",
      ),
    ][0];
    return row?.c ?? 0;
  }

  private _saveCrawlPage(p: {
    id: string;
    url: string;
    status: string;
    title: string | null;
    r2_key: string | null;
    status_code: number | null;
    chars: number | null;
    error?: string;
    discovery_depth: number;
  }): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO atlas_crawl_pages(id, url, status, title, r2_key, status_code, chars, error, discovery_depth, finished_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      p.id,
      p.url,
      p.status,
      p.title,
      p.r2_key,
      p.status_code,
      p.chars,
      p.error ?? null,
      p.discovery_depth,
      Date.now(),
    );
  }

  private _countCompletedPages(): number {
    const row = [
      ...this.sql.exec<{ c: number; [k: string]: SqlStorageValue }>(
        "SELECT COUNT(*) as c FROM atlas_crawl_pages WHERE status = 'success'",
      ),
    ][0];
    return row?.c ?? 0;
  }

  private _countFailedPages(): number {
    const row = [
      ...this.sql.exec<{ c: number; [k: string]: SqlStorageValue }>(
        "SELECT COUNT(*) as c FROM atlas_crawl_pages WHERE status = 'failed'",
      ),
    ][0];
    return row?.c ?? 0;
  }

  private _countAllCrawlPages(): number {
    const row = [
      ...this.sql.exec<{ c: number; [k: string]: SqlStorageValue }>(
        "SELECT COUNT(*) as c FROM atlas_crawl_pages",
      ),
    ][0];
    return row?.c ?? 0;
  }

  private _loadCrawlPages(offset: number, limit: number): CrawlPageRow[] {
    return [
      ...this.sql.exec<CrawlPageRow>(
        "SELECT id, url, status, title, r2_key, status_code, chars, error, discovery_depth, finished_at FROM atlas_crawl_pages ORDER BY finished_at, id LIMIT ? OFFSET ?",
        limit,
        offset,
      ),
    ];
  }

  // ============================================================
  // SSE — emit + subscribe
  // ============================================================

  private async _emit(event: string, data: unknown): Promise<void> {
    const { seq } = this._appendEvent(event, data);
    const chunk = this._encodeSse(event, JSON.stringify(data), seq);

    const dead: WritableStreamDefaultWriter<Uint8Array>[] = [];
    for (const w of this.subscribers) {
      try {
        await w.write(chunk);
      } catch {
        dead.push(w);
      }
    }
    for (const w of dead) this.subscribers.delete(w);
  }

  private _encodeSse(event: string, dataJson: string, seq: number): Uint8Array {
    return this.encoder.encode(
      `id: ${seq}\nevent: ${event}\ndata: ${dataJson}\n\n`,
    );
  }

  private _closeAllSubscribers(): void {
    for (const w of this.subscribers) {
      w.close().catch(() => {});
    }
    this.subscribers.clear();
  }
}
