import { generateObject, generateText } from "ai";
import { z } from "zod";
import { minViableSubtaskUSD, resolvePricing } from "./budget.js";
import { deriveChildCtx } from "./context.js";
import { errorMessage } from "./errors.js";
import type { Citation } from "./events.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { Researcher, ResearcherContext } from "./researcher.js";
import { runSpine, type SpineOutput } from "./spine.js";
import type { RunCtx } from "./state.js";
import { withTraceFrame } from "./trace.js";

export const ATLAS_KEY = "atlas";

const DEFAULT_ATLAS_DESCRIPTION =
  "Atlas's own deep-research spine: plans, searches, fetches, and synthesizes a grounded, citation-backed report. Strong on academic, finance, and multi-source synthesis. Default for any sub-task without a more specialized fit.";

const DECOMPOSE_SYSTEM =
  "You are a research orchestrator. Decompose the question into independent sub-tasks, each routed to the best-fit researcher from the roster. " +
  "Cut along independent seams so the sub-reports compose without cross-referencing each other's internals. " +
  "For a simple question, return a SINGLE sub-task — never split more than the question needs. " +
  "Each subtask.researcher MUST be one of the roster keys. Structured output only.";

const SYNTH_SYSTEM =
  "You synthesize ONE cited research report from several independent sub-reports. " +
  "Merge overlapping findings, surface and resolve contradictions, and write an integrated answer to the question — not a list of the sub-reports. " +
  "Preserve every concrete specific (figures, names, dates). Cite sources inline as [N] using ONLY the numbers in the provided source roster; never invent a number and never write your own Sources list — one is appended for you. Open with a brief bottom-line answer.";

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

const DECOMPOSE_FRACTION = 0.05;
const DECOMPOSE_MIN_USD = 0.02;
const SYNTH_MERGE_FRACTION = 0.3;
const SYNTH_MERGE_MIN_USD = 0.05;
const MAX_SUBTASKS = 8;

interface Subtask {
  query: string;
  researcher: string;
}

interface OrchestratedSource {
  url: string;
  title: string;
  via: string;
  chars?: number;
}

interface Dispatched {
  subtask: Subtask;
  report: string;
  sources: OrchestratedSource[];
  ok: boolean;
  error?: string;
  // Present when the child already produced a complete grounded report.
  spine?: SpineOutput;
}

export async function runOrchestrated(
  rctx: RunCtx,
  researchers: Record<string, Researcher>,
): Promise<SpineOutput> {
  const meter = rctx.meter;
  const researchModelId =
    (rctx.config.models.research as { modelId?: string }).modelId ?? "";
  const minViable = minViableSubtaskUSD(
    "broad",
    rctx.config.envelope.maxReportTokens,
    resolvePricing(researchModelId, rctx.pricing).pricing,
  );

  const synthGrant =
    meter.grant({
      fraction: SYNTH_MERGE_FRACTION,
      minUSD: SYNTH_MERGE_MIN_USD,
    }) ?? meter;
  const releaseSynth = (): void => {
    if (synthGrant !== meter) synthGrant.release();
  };

  const roster = [ATLAS_KEY, ...Object.keys(researchers)]
    .map(
      (key) =>
        `- ${key}: ${key === ATLAS_KEY ? DEFAULT_ATLAS_DESCRIPTION : researchers[key]!.description}`,
    )
    .join("\n");

  const acquisitionBefore = meter.remainingUSD();
  const maxSubtasks =
    minViable > 0
      ? Math.max(
          1,
          Math.min(
            MAX_SUBTASKS,
            Math.floor((acquisitionBefore * 0.95) / minViable),
          ),
        )
      : MAX_SUBTASKS;

  let strategy = "";
  let subtasks: Subtask[] = [{ query: rctx.question, researcher: ATLAS_KEY }];
  const decomposeGrant =
    meter.grant({ fraction: DECOMPOSE_FRACTION, minUSD: DECOMPOSE_MIN_USD }) ??
    meter;
  try {
    const decomposed = await withTraceFrame(
      rctx.recorder,
      { site: "decompose" },
      () =>
        generateObject({
          model: rctx.bindModel("lead", decomposeGrant),
          system: DECOMPOSE_SYSTEM,
          prompt:
            `Question:\n${rctx.question}\n\nResearcher roster:\n${roster}\n\n` +
            `Return the decomposition: a one-line strategy and at most ${maxSubtasks} sub-task(s) — fewer when the question is simple.`,
          schema: decomposeSchema,
          maxOutputTokens: 1200,
          maxRetries: MODEL_CALL_MAX_RETRIES,
          abortSignal: rctx.signal,
        }),
    );
    strategy = decomposed.object.strategy;
    subtasks = decomposed.object.subtasks.slice(0, maxSubtasks).map((st) => ({
      query: st.query,
      researcher:
        st.researcher === ATLAS_KEY || researchers[st.researcher]
          ? st.researcher
          : ATLAS_KEY,
    }));
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
  } finally {
    if (decomposeGrant !== meter) decomposeGrant.release();
  }
  if (strategy.trim()) rctx.emit({ type: "plan.updated", rationale: strategy });

  const acquisition = meter.remainingUSD();
  const perTask =
    subtasks.length > 0 ? acquisition / subtasks.length : acquisition;

  const dispatched: Dispatched[] = await Promise.all(
    subtasks.map(async (subtask): Promise<Dispatched> => {
      const grant = meter.grant({ maxUSD: perTask }) ?? meter;
      try {
        if (subtask.researcher === ATLAS_KEY) {
          const child = deriveChildCtx(rctx, subtask.query);
          const out = await withTraceFrame(
            rctx.recorder,
            { site: `researcher:${ATLAS_KEY}` },
            () => runSpine(child, { meter: grant }),
          );
          const sources = child.sources.fetchedSources.map(
            (s): OrchestratedSource => {
              const doc = s.sourceId
                ? child.sources.byId.get(s.sourceId)
                : undefined;
              return {
                url: s.url,
                title: s.title,
                via: doc?.metadata.method ?? "unknown",
                chars: doc?.storedChars ?? 0,
              };
            },
          );
          return { subtask, report: out.report, sources, ok: true, spine: out };
        }
        const researcher = researchers[subtask.researcher]!;
        const ctx: ResearcherContext = {
          budget: { maxUSD: grant.remainingUSD() },
          log: () => {},
          ...(rctx.signal ? { signal: rctx.signal } : {}),
        };
        const report = await researcher.research(subtask.query, ctx);
        grant.charge(report.cost ?? 0);
        return {
          subtask,
          report: report.report,
          sources: report.sources.map(
            (s): OrchestratedSource => ({
              url: s.url,
              title: s.title ?? s.url,
              via: subtask.researcher,
            }),
          ),
          ok: true,
        };
      } catch (err) {
        if (rctx.signal?.aborted) throw err;
        return {
          subtask,
          report: "",
          sources: [],
          ok: false,
          error: errorMessage(err),
        };
      } finally {
        if (grant !== meter) grant.release();
      }
    }),
  );

  const ok = dispatched.filter((d) => d.ok && d.report.trim());
  const failed = dispatched.filter((d) => !d.ok || !d.report.trim());
  const warnings = failed.map(
    (d) =>
      `Researcher "${d.subtask.researcher}" returned no report for "${d.subtask.query}"` +
      (d.error ? `: ${d.error}` : "."),
  );

  if (ok.length === 0) {
    releaseSynth();
    return {
      report: "No researcher returned a usable report for this question.",
      note: strategy,
      citations: [],
      unboundCitations: [],
      sources: [],
      warnings,
    };
  }

  // A single complete child report can pass through without a merge pass.
  const soleAtlas = ok.length === 1 ? ok[0]!.spine : undefined;
  if (soleAtlas) {
    releaseSynth();
    return {
      report: soleAtlas.report,
      note: soleAtlas.note,
      citations: soleAtlas.citations,
      unboundCitations: soleAtlas.unboundCitations,
      sources: ok[0]!.sources,
      warnings,
    };
  }

  const sources = dedupeSources(ok);

  let merged: string;
  if (ok.length === 1) {
    merged = ok[0]!.report;
  } else {
    const rosterList = sources
      .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
      .join("\n");
    const blocks = ok
      .map(
        (d, i) =>
          `## Sub-report ${i + 1} — via "${d.subtask.researcher}"\n` +
          `Query: ${d.subtask.query}\n\n${stripSourcesSection(d.report)}`,
      )
      .join("\n\n---\n\n");
    let text = "";
    try {
      const synth = await withTraceFrame(
        rctx.recorder,
        { site: "synthesize" },
        () =>
          generateText({
            model: rctx.bindModel("write", synthGrant),
            system: SYNTH_SYSTEM,
            prompt:
              `Question:\n${rctx.question}\n\n` +
              `Source roster (cite inline as [N], using only these numbers):\n${rosterList || "(none)"}\n\n` +
              `Sub-reports to merge:\n${blocks}\n\n` +
              "Write the integrated final report.",
            maxOutputTokens: rctx.config.envelope.maxReportTokens,
            maxRetries: MODEL_CALL_MAX_RETRIES,
            abortSignal: rctx.signal,
          }),
      );
      text = synth.text;
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
    }
    merged = text.trim() || ok.map((d) => d.report).join("\n\n---\n\n");
  }
  releaseSynth();

  const bound = bindRosterCitations(stripSourcesSection(merged), sources);
  return {
    report: bound.report,
    note: strategy,
    citations: bound.citations,
    unboundCitations: bound.unboundCitations,
    sources,
    warnings,
  };
}

function dedupeSources(ok: Dispatched[]): OrchestratedSource[] {
  const seen = new Set<string>();
  const out: OrchestratedSource[] = [];
  for (const d of ok) {
    for (const s of d.sources) {
      if (s.url && !seen.has(s.url)) {
        seen.add(s.url);
        out.push(s);
      }
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Remove local source lists before renumbering against the merged source roster.
function stripSourcesSection(text: string): string {
  return text
    .replace(/\n#{1,6}\s*(?:sources|references)\b[\s\S]*$/i, "")
    .trimEnd();
}

// Bind the merged report to a compact, report-wide source list.
function bindRosterCitations(
  text: string,
  roster: OrchestratedSource[],
): { report: string; citations: Citation[]; unboundCitations: string[] } {
  let bound = text;
  roster.forEach((source, i) => {
    const marker = i + 1;
    bound = bound.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(${escapeRegExp(source.url)}\\)`, "g"),
      `$1 [${marker}]`,
    );
  });

  const order: number[] = [];
  const display = new Map<number, number>();
  const unbound = new Set<string>();
  let renumbered = bound.replace(
    /\[(\d+)\](?!\()/g,
    (_match, digits: string) => {
      const n = Number(digits);
      if (n < 1 || n > roster.length) {
        unbound.add(`source_${n}`);
        return "";
      }
      if (!display.has(n)) {
        order.push(n);
        display.set(n, order.length);
      }
      return `[${display.get(n)}]`;
    },
  );
  renumbered = renumbered
    .replace(/ {2,}/g, " ")
    .replace(/ +([.,;:)])/g, "$1")
    .trim();

  const citations: Citation[] = order.map((rosterN, idx) => ({
    sourceId: `source_${rosterN}`,
    marker: idx + 1,
  }));
  const references = order
    .map((rosterN, idx) => {
      const source = roster[rosterN - 1]!;
      return `${idx + 1}. [${source.title}](${source.url})`;
    })
    .join("\n");
  const report = references
    ? `${renumbered}\n\n## Sources\n\n${references}`
    : renumbered;
  return { report, citations, unboundCitations: [...unbound] };
}
