import type { ModelOutputSchema } from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import type { ResearchClaim } from "./claims.js";
import { runSearchQueries, type MergedSearchResult } from "./search-tool.js";
import { execFetch } from "./fetch-tool.js";
import { normalizeUrlForSource } from "./url.js";

export const RECALL_MAX_FETCH = 15;
export const SURVEY_MAX_FETCH = 5;
const RESULTS_PER_QUERY = 6;
const FETCH_BATCH_SIZE = 12;
const SCOPE_MAX_TOKENS = 1_500;

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
  claimsExtracted: number;
  searchQueriesRun: number;
}

export interface SurveyOutcome {
  goal: string;
  queriesRun: string[];
  sourcesFetched: number;
  urlDupes: number;
  budgetDropped: number;
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
    const result = await ctx.deps.model.step({
      system: SCOPE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: scopePrompt(question) }],
      maxTokens: SCOPE_MAX_TOKENS,
      outputSchema: SCOPE_OUTPUT_SCHEMA,
      signal: ctx.deps.signal,
    });
    const textBlock = result.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    return parseScope(textBlock?.text ?? "{}", question);
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return { strategy: "", angles: [{ label: "primary", query: question }] };
  }
}

interface NovelSelection {
  urls: string[];
  urlDupes: number;
  budgetDropped: number;
}

export function selectNovelUrls(
  ctx: ResearchCtx,
  rankedLists: MergedSearchResult[][],
  slots: number,
): NovelSelection {
  const seen = new Set<string>();
  const urls: string[] = [];
  let urlDupes = 0;
  let budgetDropped = 0;
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
        if (urls.length >= slots) {
          budgetDropped++;
        } else {
          urls.push(result.url);
        }
        advanced = true;
        break;
      }
    }
  }
  return { urls, urlDupes, budgetDropped };
}

async function fetchUrls(ctx: ResearchCtx, urls: string[]): Promise<number> {
  let fetched = 0;
  for (let start = 0; start < urls.length; start += FETCH_BATCH_SIZE) {
    const batch = urls.slice(start, start + FETCH_BATCH_SIZE);
    const outcome = await execFetch({ urls: batch }, ctx);
    fetched += outcome.fetchedUrls?.length ?? 0;
  }
  return fetched;
}

export async function runRecall(
  ctx: ResearchCtx,
  question: string,
): Promise<RecallOutcome> {
  const { strategy, angles } = await scopeQuestion(ctx, question);
  ctx.scope.emit({
    type: "scope_completed",
    strategy,
    angles: angles.map(({ label, query }) => ({ label, query })),
  });

  const searches = await Promise.all(
    angles.map((angle, index) =>
      runSearchQueries(ctx, [angle.query], {
        limit: RESULTS_PER_QUERY,
        searchIndexStart: index,
      }),
    ),
  );
  const selection = selectNovelUrls(
    ctx,
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
  },
): Promise<SurveyOutcome> {
  const queries = readSurveyQueries(opts.goal, opts.queries);
  const search = await runSearchQueries(ctx, queries, {
    limit: RESULTS_PER_QUERY,
    searchIndexStart: opts.searchIndexStart,
  });
  const selection = selectNovelUrls(ctx, [search.results], SURVEY_MAX_FETCH);
  const claimsBefore = ctx.store.claims.claims.length;
  const sourcesFetched = await fetchUrls(ctx, selection.urls);
  await ctx.store.claims.settle();

  return {
    goal: opts.goal,
    queriesRun: queries,
    sourcesFetched,
    urlDupes: selection.urlDupes,
    budgetDropped: selection.budgetDropped,
    newClaims: ctx.store.claims.claims.slice(claimsBefore),
  };
}
