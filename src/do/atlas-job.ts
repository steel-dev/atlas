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
  planBriefAndSubQuestions,
  summarizeWebpage,
  writeReport,
  writeStructuredAnswer,
  type CitedSource,
} from "../research";
import { webSearch, type Engine, type SearchResult } from "../search";
import { getSteel } from "../steel";

const SCHEMA_VERSION = 2;
const STEP_DELAY_MS = 100;
const CRAWL_BATCH_SIZE = 5;

export type AsyncOp = "extract" | "crawl" | "research" | "task";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  engine: Engine;
  use_proxy: boolean;
}

export interface TaskSpec extends ResearchSpec {
  output_schema: Record<string, unknown>;
}

export interface CrawlSpec {
  url: string;
  limit: number;
  maxDepth?: number;
  maxDiscoveryDepth?: number;
  includePaths: string[];
  excludePaths: string[];
  crawlEntireDomain: boolean;
  allowSubdomains: boolean;
  allowExternalLinks: boolean;
  ignoreRobotsTxt: boolean;
  sitemap: "skip" | "include" | "only";
  deduplicateSimilarURLs: boolean;
  ignoreQueryParameters: boolean;
  regexOnFullURL: boolean;
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

interface ResearchInternalState {
  phase: "brief" | "search" | "fetch" | "write";
  brief?: string;
  sub_questions?: string[];
  fetch_queue?: Array<{
    url: string;
    title: string;
    snippet: string;
    sub_question: string;
  }>;
  fetch_idx?: number;
  sources?: CitedSource[];
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

  async submitExtract(jobId: string, spec: ExtractSpec): Promise<JobState> {
    const existing = this._loadState();
    if (existing) return existing;

    const state: JobState = {
      id: jobId,
      op: "extract",
      status: "queued",
      progress: { done: 0, total: spec.urls.length },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
    this._appendEvent("submitted", {
      id: jobId,
      op: "extract",
      total: spec.urls.length,
    });

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return state;
  }

  async submitResearch(jobId: string, spec: ResearchSpec): Promise<JobState> {
    const existing = this._loadState();
    if (existing) return existing;

    const state: JobState = {
      id: jobId,
      op: "research",
      status: "queued",
      progress: { done: 0, total: 3 },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
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
    return state;
  }

  async submitTask(jobId: string, spec: TaskSpec): Promise<JobState> {
    const existing = this._loadState();
    if (existing) return existing;

    const state: JobState = {
      id: jobId,
      op: "task",
      status: "queued",
      progress: { done: 0, total: 3 },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
    this._setMeta(
      "research_state",
      JSON.stringify({ phase: "brief" } satisfies ResearchInternalState),
    );
    this._appendEvent("submitted", {
      id: jobId,
      op: "task",
      query: spec.query,
    });

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return state;
  }

  async submitCrawl(jobId: string, spec: CrawlSpec): Promise<JobState> {
    const existing = this._loadState();
    if (existing) return existing;

    const state: JobState = {
      id: jobId,
      op: "crawl",
      status: "queued",
      progress: { done: 0, total: spec.limit },
      created_at: Date.now(),
    };
    this._saveState(state);
    this._setMeta("spec", JSON.stringify(spec));
    this._appendEvent("submitted", {
      id: jobId,
      op: "crawl",
      url: spec.url,
      limit: spec.limit,
    });

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    return state;
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
      return this._handleCancel();
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private _handleStatus(request: Request): Response {
    const state = this._loadState();
    if (!state) {
      return Response.json(
        {
          success: false,
          code: "E_JOB_NOT_FOUND",
          error: "Job not found",
        },
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

    return Response.json({
      success: true,
      data: { ...state, result },
    });
  }

  private _handleCrawlStatus(state: JobState, request: Request): Response {
    const url = new URL(request.url);
    const offsetRaw = url.searchParams.get("offset") ?? "0";
    const limitRaw = url.searchParams.get("limit") ?? "50";
    const offset = Math.max(0, parseInt(offsetRaw, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50));

    const pageRows = this._loadCrawlPages(offset, limit);
    const totalPages = this._countAllCrawlPages();
    const pages = pageRows.map((r) => ({
      id: r.id,
      url: r.url,
      status: r.status,
      title: r.title,
      r2_key: r.r2_key,
      status_code: r.status_code,
      chars: r.chars,
      error: r.error,
      discovery_depth: r.discovery_depth,
      finished_at: r.finished_at,
    }));

    const hasMore = offset + pages.length < totalPages;
    const result = state.status === "completed" ? this._loadResult() : null;

    return Response.json({
      success: true,
      data: {
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
    });
  }

  private _handleStream(request: Request): Response {
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

  private async _handleCancel(): Promise<Response> {
    const state = this._loadState();
    if (!state) {
      return Response.json(
        { success: false, code: "E_JOB_NOT_FOUND", error: "Job not found" },
        { status: 404 },
      );
    }
    if (state.status === "running" || state.status === "queued") {
      state.status = "cancelled";
      state.finished_at = Date.now();
      this._saveState(state);
      await this._emit("cancelled", { reason: "user_request" });
      await this.ctx.storage.deleteAlarm();
      this._closeAllSubscribers();
    }
    return Response.json({ success: true, data: state });
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
      return;
    }

    if (state.op === "extract") {
      await this._stepExtract(state);
      return;
    }
    if (state.op === "research" || state.op === "task") {
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
  }

  private async _stepExtract(state: JobState): Promise<void> {
    state.status = "running";

    const i = state.progress.done;

    if (i >= state.progress.total) {
      const result = this._buildExtractResult();
      this._setMeta("result", JSON.stringify(result));
      state.status = "completed";
      state.finished_at = Date.now();
      this._saveState(state);
      await this._emit("completed", { result });
      this._closeAllSubscribers();
      return;
    }

    this._saveState(state);

    const specRaw = this._getMeta("spec");
    if (!specRaw) {
      state.status = "failed";
      state.error = "Spec missing";
      this._saveState(state);
      await this._emit("failed", { error: state.error });
      this._closeAllSubscribers();
      return;
    }
    const spec = JSON.parse(specRaw) as ExtractSpec;
    const url = spec.urls[i];
    const useProxy = spec.use_proxy ?? true;

    try {
      await this._emit("fetching", {
        url,
        position: i + 1,
        total: state.progress.total,
      });

      const steel = getSteel(this.env);
      const scrape = await steel.scrape({
        url,
        format: ["markdown"],
        useProxy,
      });
      const markdown = scrape.content?.markdown ?? "";
      const title = scrape.metadata?.title ?? null;

      if (!markdown) {
        throw new Error("Steel returned empty markdown");
      }

      await this._emit("extracting", { url });

      const anthropic = getAnthropic(this.env);
      const { data, citations } = await extractWithSchema({
        anthropic,
        markdown,
        schema: spec.schema,
        systemPrompt: spec.prompt,
      });

      this._saveSource({ url, title, data, citations });
      await this._emit("extracted", { url, position: i + 1, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._saveSource({ url, error: message });
      await this._emit("source_error", { url, error: message });
    }

    state.progress.done = i + 1;
    this._saveState(state);
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
        const subQs = rs.sub_questions ?? [];
        if (subQs.length === 0) return this._failJob(state, "No sub-questions");

        const perQ = await Promise.all(
          subQs.map(async (q, idx) => {
            await this._emit("searching", { sub_question_idx: idx, query: q });
            const outcome = await webSearch({
              env: this.env,
              query: q,
              engine: spec.engine,
              use_proxy: spec.use_proxy,
              limit: spec.max_results_per_question,
            });
            if (!outcome.ok) {
              await this._emit("search_failed", {
                sub_question_idx: idx,
                error: outcome.error.message,
              });
              return [] as Array<SearchResult & { sub_question_idx: number }>;
            }
            await this._emit("search_results", {
              sub_question_idx: idx,
              count: outcome.results.length,
            });
            return outcome.results.map((r) => ({ ...r, sub_question_idx: idx }));
          }),
        );

        const flat = perQ.flat();
        const byUrl = new Map<string, (typeof flat)[number]>();
        for (const r of flat) {
          if (!byUrl.has(r.url)) byUrl.set(r.url, r);
        }

        const byDomain = new Map<string, number>();
        const queue: NonNullable<ResearchInternalState["fetch_queue"]> = [];
        for (const r of byUrl.values()) {
          if (queue.length >= spec.max_sources) break;
          const dCount = byDomain.get(r.domain) ?? 0;
          if (dCount >= 2) continue;
          byDomain.set(r.domain, dCount + 1);
          queue.push({
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            sub_question: subQs[r.sub_question_idx] ?? "",
          });
        }

        rs.fetch_queue = queue;
        rs.fetch_idx = 0;
        rs.sources = [];
        rs.phase = queue.length > 0 ? "fetch" : "write";
        this._setMeta("research_state", JSON.stringify(rs));

        state.progress.done = 2;
        state.progress.total = 2 + queue.length + 1;
        this._saveState(state);
        break;
      }

      case "fetch": {
        const queue = rs.fetch_queue ?? [];
        const idx = rs.fetch_idx ?? 0;

        if (idx >= queue.length) {
          rs.phase = "write";
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
        state.progress.done = 2 + (idx + 1);
        this._saveState(state);
        break;
      }

      case "write": {
        try {
          await this._emit("writing", {
            sources_count: rs.sources?.length ?? 0,
          });
          const anthropic = getAnthropic(this.env);
          const baseFields = {
            query: spec.query,
            brief: rs.brief ?? "",
            sub_questions: rs.sub_questions ?? [],
            sources: rs.sources ?? [],
          };

          let result: Record<string, unknown>;
          if (state.op === "task") {
            const taskSpec = spec as TaskSpec;
            const answer = await writeStructuredAnswer({
              anthropic,
              brief: rs.brief ?? spec.query,
              sources: rs.sources ?? [],
              output_schema: taskSpec.output_schema,
            });
            result = {
              ...baseFields,
              output: answer.data,
              basis: answer.basis,
            };
            await this._emit("completed", {
              sources_count: baseFields.sources.length,
              basis_count: answer.basis.length,
            });
          } else {
            const report = await writeReport({
              anthropic,
              brief: rs.brief ?? spec.query,
              sources: rs.sources ?? [],
            });
            result = {
              ...baseFields,
              markdown: report.markdown,
            };
            await this._emit("completed", {
              sources_count: baseFields.sources.length,
              markdown_chars: report.markdown.length,
            });
          }

          this._setMeta("result", JSON.stringify(result));
          state.status = "completed";
          state.progress.done = state.progress.total;
          state.finished_at = Date.now();
          this._saveState(state);
          this._closeAllSubscribers();
          return;
        } catch (err) {
          return this._failJob(
            state,
            `write: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
  }

  private async _stepCrawl(state: JobState): Promise<void> {
    state.status = "running";
    this._saveState(state);

    const specRaw = this._getMeta("spec");
    if (!specRaw) return this._failJob(state, "Spec missing");
    const spec = JSON.parse(specRaw) as CrawlSpec;

    if (this._getMeta("crawl_kickoff_done") !== "1") {
      await this._emit("started", { url: spec.url, limit: spec.limit });

      let robotsRules: RobotsRules | null = null;
      if (!spec.ignoreRobotsTxt) {
        robotsRules = await fetchRobotsTxt(spec.url);
        if (robotsRules) this._setMeta("robots_rules", JSON.stringify(robotsRules));
      }

      const seedNorm = normalizeUrl(spec.url, {
        ignoreQueryParameters: spec.ignoreQueryParameters,
      });
      if (seedNorm) {
        const seedKey = spec.deduplicateSimilarURLs ? canonicalKey(seedNorm) : seedNorm;
        this._markVisited(seedKey);
        this._enqueueFrontier(seedNorm, 0);
      }

      if (spec.sitemap !== "skip") {
        const candidates = discoverSitemapCandidates(spec.url, robotsRules);
        const allUrls: string[] = [];
        for (const c of candidates) {
          const urls = await fetchSitemap(c);
          allUrls.push(...urls);
          if (allUrls.length > 5000) break;
        }

        const filtered = filterCandidates(allUrls, {
          initialUrl: spec.url,
          maxDepth: spec.maxDepth,
          includePaths: spec.includePaths,
          excludePaths: spec.excludePaths,
          crawlEntireDomain: spec.crawlEntireDomain,
          allowSubdomains: spec.allowSubdomains,
          allowExternalLinks: spec.allowExternalLinks,
          regexOnFullURL: spec.regexOnFullURL,
          robotsRules,
        });

        let enqueued = 0;
        for (const f of filtered) {
          if (enqueued >= spec.limit) break;
          const key = spec.deduplicateSimilarURLs ? canonicalKey(f) : f;
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

      await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
      return;
    }

    const completed = this._countCompletedPages();
    const remaining = spec.limit - completed;
    if (remaining <= 0) return this._completeCrawl(state, spec, "limit_reached");

    const batch = this._popFrontier(Math.min(CRAWL_BATCH_SIZE, remaining));
    if (batch.length === 0) return this._completeCrawl(state, spec, "frontier_drained");

    const robotsRaw = this._getMeta("robots_rules");
    const robotsRules: RobotsRules | null = robotsRaw
      ? (JSON.parse(robotsRaw) as RobotsRules)
      : null;
    const sitemapOnly = this._getMeta("sitemap_only") === "1";
    const filterOpts = {
      initialUrl: spec.url,
      maxDepth: spec.maxDepth,
      includePaths: spec.includePaths,
      excludePaths: spec.excludePaths,
      crawlEntireDomain: spec.crawlEntireDomain,
      allowSubdomains: spec.allowSubdomains,
      allowExternalLinks: spec.allowExternalLinks,
      regexOnFullURL: spec.regexOnFullURL,
      robotsRules,
    };

    await Promise.all(
      batch.map(async (item) => {
        try {
          await this._emit("page_started", {
            url: item.url,
            depth: item.discovery_depth,
          });

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
            spec.maxDiscoveryDepth === undefined ||
            item.discovery_depth < spec.maxDiscoveryDepth;

          if (!sitemapOnly && withinDiscoveryDepth) {
            const candidates: string[] = [];
            for (const l of scrape.links ?? []) {
              if (l.url) candidates.push(l.url);
            }
            const filtered = filterCandidates(candidates, filterOpts);

            let added = 0;
            for (const f of filtered) {
              if (this._countVisited() + added >= spec.limit) break;
              const key = spec.deduplicateSimilarURLs ? canonicalKey(f) : f;
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

    state.progress.done = this._countCompletedPages();
    state.progress.total = Math.min(spec.limit, this._countVisited());
    this._saveState(state);

    const delay = spec.delay ?? 0;
    await this.ctx.storage.setAlarm(
      Date.now() + Math.max(STEP_DELAY_MS, delay * 1000),
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

    state.status = "completed";
    state.finished_at = Date.now();
    state.progress.done = completed;
    state.progress.total = completed;
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
