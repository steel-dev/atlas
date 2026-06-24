import { generateObject } from "ai";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { todayLine } from "./prompts.js";
import type { RunCtx } from "./state.js";
import { withTraceFrame } from "./trace.js";

const CHECKLIST_MAX_TOKENS = 4096;
const CHECKLIST_MAX_ITEMS = 20;
const CHECKLIST_RETRY_MAX_ITEMS = 12;
const EXPANSION_MAX_ITEMS = 8;

export type ChecklistImportance = "central" | "peripheral";
export type ChecklistVolatility = "volatile" | "stable";
export type ChecklistStatus = "open" | "grounded" | "exhausted";
export type ChecklistKind = "fact" | "analysis";
export type ChecklistScope = "single_fact" | "short_answer" | "broad";

export interface ChecklistItem {
  id: string;
  fact: string;
  kind: ChecklistKind;
  importance: ChecklistImportance;
  volatility: ChecklistVolatility;
  status: ChecklistStatus;
}

export interface Checklist {
  items: ChecklistItem[];
  nextId: number;
  scope: ChecklistScope;
}

export interface NewChecklistItem {
  fact: string;
  kind: ChecklistKind;
  importance: ChecklistImportance;
  volatility: ChecklistVolatility;
}

export interface CoverageUpdate {
  closedIds: string[];
  newItems: NewChecklistItem[];
  exhaustedIds?: string[];
}

const newItemSchema = z.object({
  fact: z.string(),
  kind: z.enum(["fact", "analysis"]),
  importance: z.enum(["central", "peripheral"]),
  volatility: z.enum(["volatile", "stable"]),
});

const checklistSchema = z.object({
  scope: z
    .enum(["single_fact", "short_answer", "broad"])
    .describe(
      "the shape a complete answer should take: single_fact = a lookup with essentially one answer (the report should be a 1-3 sentence answer-first paragraph, no headers); short_answer = a focused question (a few tight paragraphs); broad = a survey, comparison, or multi-part question (a full structured report).",
    ),
  items: z.array(newItemSchema).max(CHECKLIST_MAX_ITEMS),
});

export const coverageUpdateSchema = z.object({
  closedIds: z.array(z.string()),
  newItems: z.array(newItemSchema).max(EXPANSION_MAX_ITEMS),
  gaps: z.array(z.string()).max(5),
});

export const draftCoverageSchema = z.object({
  groundedIds: z.array(z.string()),
  exhaustedIds: z.array(z.string()),
  newItems: z.array(newItemSchema).max(EXPANSION_MAX_ITEMS),
  gaps: z
    .array(
      z.object({
        id: z.string(),
        directive: z.string(),
        needsFetch: z
          .boolean()
          .describe(
            "true if closing this gap requires fetching a source not yet in the store (a sibling page, a primary document, a retry of a failed fetch); false if the fact is already in a fetched source and only needs to be pulled out and stated.",
          ),
        candidateUrl: z
          .string()
          .optional()
          .describe(
            "When this is a needsFetch gap and one of the surfaced-but-unfetched candidate URLs listed is the specific page that closes it, copy that exact URL here so the patch step fetches it directly instead of re-searching. Use only a URL from that list — never invent one.",
          ),
      }),
    )
    .max(12),
});

const CHECKLIST_SYSTEM =
  "You are the lead planner of a deep-research run. Before any source is read, draw on what you already know to enumerate what a complete, correct answer to the research question must contain — a coverage contract for the run. " +
  "Enumerate two kinds of item. kind=fact: a specific sub-fact the answer must establish and the run is obliged to GROUND with a cited source — a name, value, date, entity, mechanism, or event. kind=analysis: a comparative or analytical move the answer must MAKE — a cross-cutting comparison, a tension that drives the topic, a synthesis across cases, or an explanation of how one thing determines another. Analysis items are reasoning over the grounded facts, not things to cite; they exist so the answer develops insight instead of a pile of facts. " +
  "This is NOT the answer and never becomes the report. The more you actually know, the LONGER and more specific this list should be — confidence means naming more required items, not assuming them away. A broad or comparative question needs several analysis items, not only facts. " +
  "Enumerate the OUTPUTS a complete answer must STATE, not only raw facts to look up. Include: any figure the answer must compute or total from parts (a sum across periods, a percentage split that adds up, the full chain from inputs to the bottom-line number); the specific named entity or identifier one level more concrete than the question's wording (the exact system, standard, statute section, part, or program name — not the category); and, when the question weighs options or asks which / whether / A-versus-B / what-to-do, an item for each branch AND for the fallback when the preferred option is not available. Add what the answer's implied audience would expect even where the question does not spell it out. " +
  "Wherever an item would name only a CATEGORY (a kind of program, a class of metric, a type of partnership, 'the relevant statute'), name instead the specific INSTANCE a domain expert expects — the actual program name, the named organization or case, the headline figure, the exact section. A line that names the category but not the instance has not done its job; commit the concrete name now even though no source has been read yet, and let the run confirm or correct it. When the question spans several domains or entities, give each its own specific items rather than one bucket line. " +
  "Tag each item three ways. kind: fact or analysis. Importance: central when the answer fails without it, peripheral when it is useful context. Volatility: volatile when it is a figure, price, date, version, status, or ranking that drifts over time and must be pinned to a current source; stable otherwise — definitions, mechanisms, settled facts, and all analysis items are stable. " +
  "Enumerate the STANDARD deliverable a domain expert would demand even when the question foregrounds something narrower: for a clinical question, the standard-of-care safety actions and the red-flag thresholds that trigger escalation; for a financial question, the full-period figures and the standard tables, not only the one line asked about; for an academic or comparative question, the expected sections, the count of authorities or recommendations, and a formatted bibliography. The question names the entry point; a complete answer is what the field expects around it. When in doubt, list a required item the question only implies rather than omitting it. " +
  "Decompose to the leaf, not the bucket. When a complete answer is a SET — a top-N list, the options to a decision, the members of a category or standard the question names, the steps of a process — emit ONE item per expected member, never a single 'list the X' line; name the members you can already and let the run confirm or correct them. When the question asks HOW something works or WHY an outcome follows, break the mechanism into its causal sub-steps as separate items rather than one 'explain the mechanism' line. " +
  "When the question weighs options, asks which / whether / best, or what to do, add analysis items for the decision MOVES a sound answer makes: one that RANKS the options on the question's own criteria; one for CHOOSE-WHEN — the condition under which each option is the right pick; one separating what is REQUIRED from what is OPTIONAL; and one for IN-WINDOW vs OUT — which options fall inside the constraints the question fixes (budget, timeframe, jurisdiction, compatibility) and which are excluded. " +
  "Keep every item to one tight line — the named entity plus the exact value, operation, or period it pins, with no explanatory prose; terse items are cheaper, so list MORE of them rather than fewer longer ones. " +
  "Bind each fact as a tuple — the named entity, the exact operation, dimension, or period it applies to, and the exact value with its unit — never a loose description: a spec attached to the wrong operation, the wrong period, or the wrong year scores as absent, so pin the period and basis the question grades on. When a fact is keyed to a date or fiscal period, name the specific period (the completed year the question grades, not merely the current one). " +
  "Keep separate the facts the question GIVES you and your own GUESS at the answer. When you name a specific instance the question does not provide — your best guess at who, what, or which — frame that item as one to CONFIRM OR CORRECT from sources, never a premise the report must defend; do not build several items around a single unconfirmed guess, and never let a guessed entity justify citing sources outside the question's time window or scope. " +
  "Phrase any safety-critical directive — stopping or holding a medication or exposure, restricting an activity, an emergency threshold — as a categorical imperative stating what to do now and on whose authority, never as a hedged 'reduce if appropriate' option. " +
  "Also classify the deliverable's scope so the writer can match the answer's length and shape to the question: single_fact for a lookup with essentially one answer, short_answer for a focused question, broad for a survey, comparison, or multi-part question. Structured output only.";

export async function buildChecklist(
  rctx: RunCtx,
  grant: BudgetGrant,
): Promise<Checklist | null> {
  if (grant.floored()) return null;
  const basePrompt =
    `${todayLine(rctx.todayISO)}\n\n` +
    `Research question: ${rctx.question}\n\n` +
    "Enumerate the sub-facts a complete answer must ground with sources, plus the analytical moves it must make. " +
    "Cover every facet the question explicitly asks for, and for each item name the exact value, date, entity, statute section, program, or comparison it must pin down — the concrete instance, never just the category. " +
    "When the question spans several domains or entities, give each its own specific items rather than one bucket line. ";
  const attempt = (maxItems: number, terse: boolean) =>
    withTraceFrame(rctx.recorder, { site: "checklist" }, () =>
      generateObject({
        model: rctx.bindModel("lead", grant),
        system: CHECKLIST_SYSTEM,
        prompt:
          basePrompt +
          (terse
            ? "Keep each item to a single tight line so the whole list fits in one response. "
            : "") +
          `Classify the scope, then list at most ${maxItems} items, ordered most central first.`,
        schema: checklistSchema,
        maxOutputTokens: CHECKLIST_MAX_TOKENS,
        maxRetries: MODEL_CALL_MAX_RETRIES,
        abortSignal: rctx.signal,
      }),
    );
  try {
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(CHECKLIST_MAX_ITEMS, false);
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
      result = await attempt(CHECKLIST_RETRY_MAX_ITEMS, true);
    }
    const items: ChecklistItem[] = result.object.items
      .map((item, index) => ({
        id: `item_${index + 1}`,
        fact: item.fact.trim(),
        kind: item.kind,
        importance: item.importance,
        volatility: item.volatility,
        status: "open" as ChecklistStatus,
      }))
      .filter((item) => item.fact.length > 0);
    if (items.length === 0) return null;
    return { items, nextId: items.length + 1, scope: result.object.scope };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}

export function checklistFromSubQuestions(
  subQuestions: string[],
): Checklist | null {
  const items: ChecklistItem[] = subQuestions
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, CHECKLIST_MAX_ITEMS)
    .map((fact, index) => ({
      id: `item_${index + 1}`,
      fact,
      kind: "fact" as ChecklistKind,
      importance: "central" as ChecklistImportance,
      volatility: "volatile" as ChecklistVolatility,
      status: "open" as ChecklistStatus,
    }));
  if (items.length === 0) return null;
  return { items, nextId: items.length + 1, scope: "broad" };
}

export function applyCoverageUpdate(
  checklist: Checklist,
  update: CoverageUpdate,
): void {
  const closed = new Set(update.closedIds);
  const exhausted = new Set(update.exhaustedIds ?? []);
  for (const item of checklist.items) {
    if (item.status !== "open") continue;
    if (closed.has(item.id)) item.status = "grounded";
    else if (exhausted.has(item.id)) item.status = "exhausted";
  }
  const known = new Set(
    checklist.items.map((item) => item.fact.trim().toLowerCase()),
  );
  for (const raw of update.newItems) {
    const fact = raw.fact.trim();
    if (!fact || known.has(fact.toLowerCase())) continue;
    known.add(fact.toLowerCase());
    checklist.items.push({
      id: `item_${checklist.nextId++}`,
      fact,
      kind: raw.kind,
      importance: raw.importance,
      volatility: raw.volatility,
      status: "open",
    });
  }
}

export function openItems(checklist: Checklist): ChecklistItem[] {
  return checklist.items.filter((item) => item.status === "open");
}

export function isAnswered(checklist: Checklist): boolean {
  return !checklist.items.some(
    (item) =>
      item.status === "open" &&
      item.importance === "central" &&
      item.kind === "fact",
  );
}

export function renderChecklistContract(checklist: Checklist): string {
  return checklist.items
    .filter((item) => item.kind === "fact")
    .map(
      (item) =>
        `- [${item.importance}·${item.volatility}] ${item.fact}`,
    )
    .join("\n");
}

export function renderChecklistAudit(checklist: Checklist): string {
  return checklist.items
    .filter((item) => item.kind === "fact")
    .map((item) => {
      const tags = `${item.importance}·${item.volatility}·${item.status}`;
      return `[${item.id}·${tags}] ${item.fact}`;
    })
    .join("\n");
}

export function renderAnalyticalDemands(checklist: Checklist): string {
  return checklist.items
    .filter((item) => item.kind === "analysis")
    .map((item) => `- ${item.fact}`)
    .join("\n");
}

export function renderDeliverableContract(checklist: Checklist): string {
  const facts = checklist.items.filter((item) => item.kind === "fact");
  const analysis = checklist.items.filter((item) => item.kind === "analysis");
  const lines: string[] = [];
  if (facts.length > 0) {
    lines.push(
      "Facts your report MUST state, each with the specific value/entity/date it names and a citation:",
    );
    for (const item of facts) {
      lines.push(`- [${item.importance}] ${item.fact}`);
    }
  }
  if (analysis.length > 0) {
    lines.push("Analytical moves your report MUST make:");
    for (const item of analysis) {
      lines.push(`- ${item.fact}`);
    }
  }
  if (lines.length === 0) return "";
  return (
    "DELIVERABLE CONTRACT — your report is judged on these. State each fact you have grounded plainly and up front; never bury or hedge a fact your notes support, and never silently drop one. Only if your notes genuinely lack an item may you note its absence in one short clause.\n" +
    lines.join("\n")
  );
}

export function renderDeliverableShape(checklist: Checklist): string {
  switch (checklist.scope) {
    case "single_fact":
      return "DELIVERABLE SHAPE: a single-fact lookup. Lead with the direct answer in its shortest canonical form, keep it to 1-3 sentences, and use NO section headers. Do not expand it into a multi-section report.";
    case "short_answer":
      return "DELIVERABLE SHAPE: a focused question. Lead with the bottom-line answer, then a few tight paragraphs; add headers only where they genuinely help.";
    default:
      return "DELIVERABLE SHAPE: a broad question. A full structured report fits. Open with a brief bottom-line, then the structured detail; do not pad with re-derivation of the same point.";
  }
}
