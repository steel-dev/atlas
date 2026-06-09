import type { ModelOutputSchema } from "./model.js";
import { researchBudgetExhaustedReason, type ResearchCtx } from "./runtime.js";
import { withRole } from "./recording.js";
import type { ResearchClaim } from "./claims.js";
import { runSearchQueries, type MergedSearchResult } from "./search-tool.js";
import { execFetch } from "./fetch-tool.js";
import { normalizeUrlForSource } from "./url.js";

export const RECALL_MAX_FETCH = 15;
export const SURVEY_MAX_FETCH = 5;
const RESULTS_PER_QUERY = 6;
const FETCH_BATCH_SIZE = 12;
const SCOPE_MAX_TOKENS = 1_500;
const TRIAGE_MAX_TOKENS = 1_500;
const TRIAGE_SNIPPET_CHARS = 200;

export interface ResearchAngle {
  label: string;
  query: string;
  rationale?: string;
}

export interface RecallOutcome {
  angles: ResearchAngle[];
  strategy: string;
  sourcesFetched: number;
  urlDupes: number;
  budgetDropped: number;
  spamDropped: number;
  lowRelevanceDropped: number;
  claimsExtracted: number;
  searchQueriesRun: number;
}

export interface SurveyOutcome {
  goal: string;
  queriesRun: string[];
  sourcesFetched: number;
  urlDupes: number;
  budgetDropped: number;
  spamDropped: number;
  lowRelevanceDropped: number;
  newClaims: ResearchClaim[];
}

const SCOPE_OUTPUT_SCHEMA: ModelOutputSchema = {
  name: "research_scope",
  schema: {
    type: "object",
    required: ["strategy", "angles"],
    properties: {
      strategy: { type: "string" },
      angles: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          required: ["label", "query"],
          properties: {
            label: { type: "string" },
            query: { type: "string" },
            rationale: { type: "string" },
          },
        },
      },
    },
  },
};

const SCOPE_SYSTEM_PROMPT =
  "You decompose one research question into complementary web search angles for a research run. Structured output only.";

function scopePrompt(question: string): string {
  return (
    "Decompose this research question into complementary web search angles.\n\n" +
    `## Question\n${question}\n\n` +
    "## Task\n" +
    "Scale the number of angles to the question. A narrow factual question needs 1-2 angles; a broad or multi-faceted question needs up to 5-6 distinct ones. Pick angles that suit the question's domain. Examples:\n" +
    "- broad/primary · academic/technical · recent news · contrarian/skeptical · practitioner/implementation\n" +
    "- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\n" +
    "- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\n\n" +
    "Make each query specific enough to surface high-signal results. Avoid redundancy.\n" +
    "Return a 1-2 sentence decomposition strategy and the angles.\n\nStructured output only."
  );
}

interface RawScope {
  strategy?: unknown;
  angles?: unknown;
}

function parseScope(text: string, question: string): {
  strategy: string;
  angles: ResearchAngle[];
} {
  let raw: RawScope = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) raw = parsed as RawScope;
  } catch {
    raw = {};
  }
  const angles: ResearchAngle[] = [];
  if (Array.isArray(raw.angles)) {
    for (const entry of raw.angles) {
      const candidate = entry as {
        label?: unknown;
        query?: unknown;
        rationale?: unknown;
      };
      const label =
        typeof candidate.label === "string" ? candidate.label.trim() : "";
      const query =
        typeof candidate.query === "string" ? candidate.query.trim() : "";
      if (!query) continue;
      angles.push({
        label: label || `angle-${angles.length + 1}`,
        query,
        ...(typeof candidate.rationale === "string" && candidate.rationale
          ? { rationale: candidate.rationale }
          : {}),
      });
      if (angles.length >= 6) break;
    }
  }
  if (angles.length === 0) {
    angles.push({ label: "primary", query: question });
  }
  return {
    strategy: typeof raw.strategy === "string" ? raw.strategy : "",
    angles,
  };
}

export async function scopeQuestion(
  ctx: ResearchCtx,
  question: string,
): Promise<{ strategy: string; angles: ResearchAngle[] }> {
  try {
    const result = await withRole("recall.scope", () =>
      ctx.deps.model.step({
        system: SCOPE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: scopePrompt(question) }],
        maxTokens: SCOPE_MAX_TOKENS,
        outputSchema: SCOPE_OUTPUT_SCHEMA,
        signal: ctx.deps.signal,
      }),
    );
    const textBlock = result.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    return parseScope(textBlock?.text ?? "{}", question);
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return { strategy: "", angles: [{ label: "primary", query: question }] };
  }
}

export interface NovelSelection {
  urls: string[];
  urlDupes: number;
  budgetDropped: number;
  spamDropped: number;
  lowRelevanceDropped: number;
}

type TriageRelevance = "high" | "medium" | "low";

interface TriageVerdict {
  relevance: TriageRelevance;
  spam: boolean;
}

const TRIAGE_TIER: Record<TriageRelevance, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const TRIAGE_OUTPUT_SCHEMA: ModelOutputSchema = {
  name: "search_triage",
  schema: {
    type: "object",
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "relevance", "spam"],
          properties: {
            index: { type: "integer", minimum: 0 },
            relevance: { type: "string", enum: ["high", "medium", "low"] },
            spam: { type: "boolean" },
          },
        },
      },
    },
  },
};

const TRIAGE_SYSTEM_PROMPT =
  "You triage web search results for a deep research run, deciding which are worth the cost of fetching. Structured output only.";

function triageHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function triagePrompt(target: string, candidates: MergedSearchResult[]): string {
  const lines = candidates
    .map((candidate, index) => {
      const snippet = (candidate.snippet || "(no snippet)").slice(
        0,
        TRIAGE_SNIPPET_CHARS,
      );
      return `[${index}] ${candidate.title || "(untitled)"} — ${triageHost(candidate.url)}\n    ${snippet}`;
    })
    .join("\n");
  return (
    `## Research target\n${target}\n\n` +
    `## Candidate results\n${lines}\n\n` +
    "## Task\n" +
    "For each candidate index, judge two things from the title and snippet alone — you are deciding whether to pay to fetch the page, not reading it:\n" +
    '- relevance to the research target: "high" (directly answers it or is a strong signal), "medium" (related or partial), "low" (off-topic or only tangential).\n' +
    "- spam: true ONLY if the page is genuinely worthless as evidence — SEO spam, a content farm, a contentless paywall stub, or a page auto-generated from the search query itself (a crossword-solver, stock-photo, or keyword-echo page that just reflects your terms back). A real event/race listing, results page, directory, or aggregator is NOT spam: for \"what was X\" questions the answer often lives exactly there, so judge those on relevance, not spam.\n" +
    "Return one verdict per candidate index. Do not omit any index.\n\nStructured output only."
  );
}

interface RawTriage {
  verdicts?: unknown;
}

function parseTriage(
  text: string,
  candidateCount: number,
): Map<number, TriageVerdict> | null {
  let raw: RawTriage = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) raw = parsed as RawTriage;
  } catch {
    return null;
  }
  if (!Array.isArray(raw.verdicts)) return null;
  const verdicts = new Map<number, TriageVerdict>();
  for (const entry of raw.verdicts) {
    const candidate = entry as {
      index?: unknown;
      relevance?: unknown;
      spam?: unknown;
    };
    const index =
      typeof candidate.index === "number" ? Math.trunc(candidate.index) : -1;
    if (index < 0 || index >= candidateCount) continue;
    const relevance: TriageRelevance =
      candidate.relevance === "high" || candidate.relevance === "low"
        ? candidate.relevance
        : "medium";
    verdicts.set(index, { relevance, spam: candidate.spam === true });
  }
  return verdicts.size > 0 ? verdicts : null;
}

// Round-robin across the per-angle ranked lists, skipping URLs already seen in
// this selection or already stored from an earlier stage. No budget cap — that
// is applied after relevance triage.
export function dedupeCandidates(
  ctx: ResearchCtx,
  rankedLists: MergedSearchResult[][],
): { candidates: MergedSearchResult[]; urlDupes: number } {
  const seen = new Set<string>();
  const candidates: MergedSearchResult[] = [];
  let urlDupes = 0;
  const cursors = rankedLists.map(() => 0);

  let advanced = true;
  while (advanced) {
    advanced = false;
    for (let list = 0; list < rankedLists.length; list++) {
      const results = rankedLists[list];
      while (cursors[list] < results.length) {
        const result = results[cursors[list]++];
        const key = normalizeUrlForSource(result.url);
        if (seen.has(key) || ctx.store.sourceDocuments.has(key)) {
          urlDupes++;
          continue;
        }
        seen.add(key);
        candidates.push(result);
        advanced = true;
        break;
      }
    }
  }
  return { candidates, urlDupes };
}

// Turn deduped candidates + optional triage verdicts into the URLs to fetch.
// With no verdicts it is a plain rank-order cap (the pre-triage behavior). With
// verdicts: spam is always dropped; when the survivors still fit the budget
// they are all kept (no recall lost while slots remain); only when over budget
// are they prioritized by relevance tier, dropping the lowest-ranked overflow.
export function applyRelevanceSelection(
  candidates: MergedSearchResult[],
  verdicts: Map<number, TriageVerdict> | null,
  slots: number,
): Omit<NovelSelection, "urlDupes"> {
  if (!verdicts || verdicts.size === 0) {
    const kept = candidates.slice(0, slots);
    return {
      urls: kept.map((candidate) => candidate.url),
      budgetDropped: Math.max(0, candidates.length - slots),
      spamDropped: 0,
      lowRelevanceDropped: 0,
    };
  }

  const verdictAt = (index: number): TriageVerdict =>
    verdicts.get(index) ?? { relevance: "medium", spam: false };
  const tagged = candidates.map((candidate, index) => ({
    candidate,
    verdict: verdictAt(index),
  }));

  let survivors = tagged.filter((item) => !item.verdict.spam);
  let spamDropped = tagged.length - survivors.length;
  // A panel that flags every result as spam is malfunctioning; distrust it
  // rather than fetch nothing.
  if (survivors.length === 0) {
    survivors = tagged;
    spamDropped = 0;
  }

  if (survivors.length <= slots) {
    return {
      urls: survivors.map((item) => item.candidate.url),
      budgetDropped: 0,
      spamDropped,
      lowRelevanceDropped: 0,
    };
  }

  // Over budget: stable-sort by relevance tier (Array.prototype.sort is stable),
  // so the round-robin order survives within a tier and the lowest-relevance
  // results fall into the dropped overflow.
  const ordered = survivors
    .slice()
    .sort(
      (a, b) =>
        TRIAGE_TIER[a.verdict.relevance] - TRIAGE_TIER[b.verdict.relevance],
    );
  const kept = ordered.slice(0, slots);
  const dropped = ordered.slice(slots);
  return {
    urls: kept.map((item) => item.candidate.url),
    budgetDropped: dropped.length,
    spamDropped,
    lowRelevanceDropped: dropped.filter(
      (item) => item.verdict.relevance === "low",
    ).length,
  };
}

async function triageCandidates(
  ctx: ResearchCtx,
  target: string,
  candidates: MergedSearchResult[],
): Promise<Map<number, TriageVerdict> | null> {
  if (candidates.length < 2) return null;
  if (researchBudgetExhaustedReason(ctx)) return null;
  const model = ctx.deps.leafModel ?? ctx.deps.model;
  try {
    const result = await withRole("recall.triage", () =>
      model.step({
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: triagePrompt(target, candidates) }],
        maxTokens: TRIAGE_MAX_TOKENS,
        outputSchema: TRIAGE_OUTPUT_SCHEMA,
        signal: ctx.deps.signal,
      }),
    );
    const textBlock = result.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    return parseTriage(textBlock?.text ?? "{}", candidates.length);
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return null;
  }
}

// Dedupe → relevance triage → budget-aware selection. The triage call is best
// effort: on a pool below 2, an exhausted token budget, a model error, or
// unparseable output it returns null and selection falls back to rank order.
export async function selectSourcesToFetch(
  ctx: ResearchCtx,
  target: string,
  rankedLists: MergedSearchResult[][],
  slots: number,
): Promise<NovelSelection> {
  const { candidates, urlDupes } = dedupeCandidates(ctx, rankedLists);
  const verdicts = await triageCandidates(ctx, target, candidates);
  const selection = applyRelevanceSelection(candidates, verdicts, slots);
  return { ...selection, urlDupes };
}

// Pure dedupe + rank-order cap, kept for callers and tests that skip relevance
// triage. Equivalent to selectSourcesToFetch with no verdicts.
export function selectNovelUrls(
  ctx: ResearchCtx,
  rankedLists: MergedSearchResult[][],
  slots: number,
): NovelSelection {
  const { candidates, urlDupes } = dedupeCandidates(ctx, rankedLists);
  const selection = applyRelevanceSelection(candidates, null, slots);
  return { ...selection, urlDupes };
}

async function fetchUrls(
  ctx: ResearchCtx,
  urls: string[],
  goal?: string,
): Promise<number> {
  let fetched = 0;
  for (let start = 0; start < urls.length; start += FETCH_BATCH_SIZE) {
    const batch = urls.slice(start, start + FETCH_BATCH_SIZE);
    const outcome = await execFetch({ urls: batch, goal }, ctx);
    fetched += outcome.fetchedUrls?.length ?? 0;
  }
  return fetched;
}

export async function runRecall(
  ctx: ResearchCtx,
  question: string,
  searchIndexRef: { next: number } = { next: 0 },
): Promise<RecallOutcome> {
  const { strategy, angles } = await scopeQuestion(ctx, question);
  ctx.scope.emit({
    type: "scope_completed",
    strategy,
    angles: angles.map(({ label, query }) => ({ label, query })),
  });

  const searchIndexBase = searchIndexRef.next;
  searchIndexRef.next += angles.length;
  const searches = await Promise.all(
    angles.map((angle, index) =>
      runSearchQueries(ctx, [angle.query], {
        limit: RESULTS_PER_QUERY,
        searchIndexStart: searchIndexBase + index,
      }),
    ),
  );
  const selection = await selectSourcesToFetch(
    ctx,
    question,
    searches.map((outcome) => outcome.results),
    RECALL_MAX_FETCH,
  );
  const claimsBefore = ctx.store.claims.claims.length;
  const sourcesFetched = await fetchUrls(ctx, selection.urls);
  await ctx.store.claims.settle();

  return {
    angles,
    strategy,
    sourcesFetched,
    urlDupes: selection.urlDupes,
    budgetDropped: selection.budgetDropped,
    spamDropped: selection.spamDropped,
    lowRelevanceDropped: selection.lowRelevanceDropped,
    claimsExtracted: ctx.store.claims.claims.length - claimsBefore,
    searchQueriesRun: angles.length,
  };
}

function readSurveyQueries(goal: string, queries: string[] | undefined): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of queries ?? []) {
    const query = String(raw ?? "").trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    cleaned.push(query);
    if (cleaned.length >= 3) break;
  }
  return cleaned.length > 0 ? cleaned : [goal];
}

export async function runSurvey(
  ctx: ResearchCtx,
  opts: {
    goal: string;
    queries?: string[];
    searchIndexStart: number;
    question?: string;
  },
): Promise<SurveyOutcome> {
  const queries = readSurveyQueries(opts.goal, opts.queries);
  const search = await runSearchQueries(ctx, queries, {
    limit: RESULTS_PER_QUERY,
    searchIndexStart: opts.searchIndexStart,
  });
  const triageTarget = opts.question
    ? `${opts.question}\n\n(Judge relevance to the question above. Sub-goal currently being pursued: ${opts.goal})`
    : opts.goal;
  const selection = await selectSourcesToFetch(
    ctx,
    triageTarget,
    [search.results],
    SURVEY_MAX_FETCH,
  );
  const claimsBefore = ctx.store.claims.claims.length;
  const sourcesFetched = await fetchUrls(ctx, selection.urls, opts.goal);
  await ctx.store.claims.settle();

  return {
    goal: opts.goal,
    queriesRun: queries,
    sourcesFetched,
    urlDupes: selection.urlDupes,
    budgetDropped: selection.budgetDropped,
    spamDropped: selection.spamDropped,
    lowRelevanceDropped: selection.lowRelevanceDropped,
    newClaims: ctx.store.claims.claims.slice(claimsBefore),
  };
}
