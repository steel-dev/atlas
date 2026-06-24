import { randomUUID } from "node:crypto";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { AtlasConfig, ResearchOptions } from "./config.js";
import { resolveRunConfig } from "./config.js";
import { EVENT_SCHEMA_VERSION, type RunStats } from "./events.js";
import { errorMessage } from "./errors.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type {
  Researcher,
  ResearcherContext,
  ResearchReport,
} from "./researcher.js";
import type { ResearchResult, SourceRecord } from "./run.js";

const DECOMPOSE_SYSTEM =
  "You are a research orchestrator. Decompose the question into independent sub-tasks, each routed to the best-fit researcher from the roster. " +
  "Cut along independent seams so the sub-reports compose without cross-referencing each other's internals. " +
  "For a simple question, return a SINGLE sub-task — never split more than the question needs. " +
  "Each subtask.researcher MUST be one of the roster keys. Structured output only.";

const SYNTH_SYSTEM =
  "You synthesize ONE cited research report from several independent sub-reports. " +
  "Merge overlapping findings, surface and resolve contradictions, and write an integrated answer to the question — not a list of the sub-reports. " +
  "Preserve every concrete specific (figures, names, dates) and cite sources inline by URL. Open with a brief bottom-line answer.";

const decomposeSchema = z.object({
  strategy: z.string(),
  subtasks: z
    .array(
      z.object({
        query: z.string(),
        researcher: z.string(),
        rationale: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
});

interface Subtask {
  query: string;
  researcher: string;
}

interface Dispatched {
  subtask: Subtask;
  report: ResearchReport | null;
  error?: string;
}

export async function runOrchestrated(
  config: AtlasConfig,
  question: string,
  options: ResearchOptions,
  researchers: Record<string, Researcher>,
): Promise<ResearchResult> {
  const startedAt = Date.now();
  const resolved = resolveRunConfig(config, options);
  const lead = resolved.models.lead;

  const roster = Object.entries(researchers)
    .map(([key, r]) => `- ${key}: ${r.describe}`)
    .join("\n");

  const decomposed = await generateObject({
    model: lead,
    system: DECOMPOSE_SYSTEM,
    prompt:
      `Question:\n${question}\n\nResearcher roster:\n${roster}\n\n` +
      "Return the decomposition: a one-line strategy and the sub-tasks.",
    schema: decomposeSchema,
    maxOutputTokens: 1200,
    maxRetries: MODEL_CALL_MAX_RETRIES,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });

  const subtasks: Subtask[] = decomposed.object.subtasks.map((st) => ({
    query: st.query,
    researcher: researchers[st.researcher] ? st.researcher : "atlas",
  }));

  const perTask = Math.max(0.02, (resolved.budgetUSD * 0.8) / subtasks.length);
  const log = (_message: string): void => {};

  const dispatched: Dispatched[] = await Promise.all(
    subtasks.map(async (subtask): Promise<Dispatched> => {
      const researcher = researchers[subtask.researcher] ?? researchers.atlas;
      if (!researcher) return { subtask, report: null, error: "no researcher" };
      const ctx: ResearcherContext = {
        budget: { maxUSD: perTask },
        log,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      try {
        const report = await researcher.research(subtask.query, ctx);
        return { subtask, report };
      } catch (err) {
        return { subtask, report: null, error: errorMessage(err) };
      }
    }),
  );

  const ok = dispatched.filter(
    (d): d is Dispatched & { report: ResearchReport } => d.report !== null,
  );
  const failed = dispatched.filter((d) => d.report === null);

  let report: string;
  if (ok.length === 0) {
    report = "No researcher returned a usable report for this question.";
  } else if (ok.length === 1) {
    report = ok[0]!.report.report;
  } else {
    const blocks = ok
      .map((d, i) => {
        const urls = d.report.sources.map((s) => s.url).join(", ");
        return (
          `## Sub-report ${i + 1} — via "${d.subtask.researcher}"\n` +
          `Query: ${d.subtask.query}\n` +
          (d.report.confidence !== undefined
            ? `Reported confidence: ${d.report.confidence}\n`
            : "") +
          `\n${d.report.report}\n\nSources: ${urls || "(none)"}`
        );
      })
      .join("\n\n---\n\n");
    const synth = await generateText({
      model: lead,
      system: SYNTH_SYSTEM,
      prompt: `Question:\n${question}\n\n${blocks}\n\nWrite the integrated final report.`,
      maxOutputTokens: resolved.envelope.maxReportTokens,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    report = synth.text;
  }

  const sources: SourceRecord[] = [];
  for (const d of ok) {
    for (const s of d.report.sources) {
      sources.push({
        id: "",
        url: s.url,
        finalUrl: s.url,
        title: s.title ?? s.url,
        via: d.subtask.researcher,
        chars: 0,
      });
    }
  }

  const costUSD = ok.reduce((sum, d) => sum + (d.report.cost ?? 0), 0);
  const stats: RunStats = {
    effort: resolved.effort,
    searches: 0,
    searchCacheHits: 0,
    modelCacheHits: 0,
    modelGatePeakWidth: 0,
    sourcesFetched: sources.length,
    sourcesFailed: 0,
    claimsExtracted: 0,
    claimsUnsupported: 0,
    claimsVerified: 0,
    claimsConfirmed: 0,
    claimsScreened: 0,
    claimsContested: 0,
    claimsRefuted: 0,
    citationsBound: 0,
    citationsUnsupported: 0,
    dupesDropped: 0,
    agentsSpawned: dispatched.length,
    maxDepth: 1,
    singleAgent: false,
    tokens: {},
    costUSD: Math.round(costUSD * 10000) / 10000,
    durationMs: Date.now() - startedAt,
    budgetExhausted: false,
    tokensExhausted: false,
    agentCapReached: false,
    stopReason: "completed",
  };

  return {
    runId:
      options.runId ?? `orc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    question,
    report,
    note: decomposed.object.strategy,
    claims: {
      confirmed: [],
      screened: [],
      contested: [],
      refuted: [],
      unverified: [],
    },
    openQuestions: [],
    sources,
    citations: [],
    unsupportedSentences: failed.map(
      (d) =>
        `Researcher "${d.subtask.researcher}" returned no report for "${d.subtask.query}"` +
        (d.error ? `: ${d.error}` : "."),
    ),
    stats,
    traceVersion: EVENT_SCHEMA_VERSION,
  };
}
