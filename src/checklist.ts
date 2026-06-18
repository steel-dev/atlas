import { generateObject } from "ai";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { todayLine } from "./prompts.js";
import type { RunCtx } from "./state.js";
import { withTraceFrame } from "./trace.js";

const CHECKLIST_MAX_TOKENS = 900;
const CHECKLIST_MAX_ITEMS = 12;
const EXPANSION_MAX_ITEMS = 4;

export type ChecklistImportance = "central" | "peripheral";
export type ChecklistVolatility = "volatile" | "stable";
export type ChecklistStatus = "open" | "grounded";

export interface ChecklistItem {
  id: string;
  fact: string;
  importance: ChecklistImportance;
  volatility: ChecklistVolatility;
  status: ChecklistStatus;
}

export interface Checklist {
  items: ChecklistItem[];
  nextId: number;
}

export interface NewChecklistItem {
  fact: string;
  importance: ChecklistImportance;
  volatility: ChecklistVolatility;
}

export interface CoverageUpdate {
  closedIds: string[];
  newItems: NewChecklistItem[];
}

const newItemSchema = z.object({
  fact: z.string(),
  importance: z.enum(["central", "peripheral"]),
  volatility: z.enum(["volatile", "stable"]),
});

const checklistSchema = z.object({
  items: z.array(newItemSchema).max(CHECKLIST_MAX_ITEMS),
});

export const coverageUpdateSchema = z.object({
  closedIds: z.array(z.string()),
  newItems: z.array(newItemSchema).max(EXPANSION_MAX_ITEMS),
  gaps: z.array(z.string()).max(5),
});

const CHECKLIST_SYSTEM =
  "You are the lead planner of a deep-research run. Before any source is read, draw on what you already know to enumerate the sub-facts a complete, correct answer to the research question must establish — a coverage contract the run is obliged to ground with sources. " +
  "This is NOT the answer and never becomes the report: it is the list of things that must be FOUND and cited. The more you actually know about this topic, the LONGER and more specific this list should be — confidence means naming more required sub-facts, not assuming them away. " +
  "Tag each sub-fact two ways. Importance: central when the answer fails without it, peripheral when it is useful context. Volatility: volatile when it is a figure, price, date, version, status, ranking, or anything that drifts over time and so must be pinned to a current source rather than recalled; stable when it is a definition, mechanism, or settled historical fact unlikely to have changed. Structured output only.";

export async function buildChecklist(
  rctx: RunCtx,
  grant: BudgetGrant,
): Promise<Checklist | null> {
  if (grant.floored()) return null;
  try {
    const result = await withTraceFrame(
      rctx.recorder,
      { site: "checklist" },
      () =>
        generateObject({
          model: rctx.bindModel("lead", grant),
          system: CHECKLIST_SYSTEM,
          prompt:
            `${todayLine(rctx.todayISO)}\n\n` +
            `Research question: ${rctx.question}\n\n` +
            "Enumerate the sub-facts a complete answer must ground with sources. " +
            "Cover every facet the question explicitly asks for, and name the exact value, date, entity, or comparison each sub-fact must pin down. " +
            `List at most ${CHECKLIST_MAX_ITEMS}, ordered most central first.`,
          schema: checklistSchema,
          maxOutputTokens: CHECKLIST_MAX_TOKENS,
          maxRetries: MODEL_CALL_MAX_RETRIES,
          abortSignal: rctx.signal,
        }),
    );
    const items: ChecklistItem[] = result.object.items
      .map((item, index) => ({
        id: `item_${index + 1}`,
        fact: item.fact.trim(),
        importance: item.importance,
        volatility: item.volatility,
        status: "open" as ChecklistStatus,
      }))
      .filter((item) => item.fact.length > 0);
    if (items.length === 0) return null;
    return { items, nextId: items.length + 1 };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}

export function applyCoverageUpdate(
  checklist: Checklist,
  update: CoverageUpdate,
): void {
  const closed = new Set(update.closedIds);
  for (const item of checklist.items) {
    if (item.status === "open" && closed.has(item.id)) {
      item.status = "grounded";
    }
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
      item.volatility === "volatile",
  );
}

export function renderChecklistContract(checklist: Checklist): string {
  return checklist.items
    .map(
      (item) =>
        `- [${item.importance}·${item.volatility}] ${item.fact}`,
    )
    .join("\n");
}

export function renderChecklistAudit(checklist: Checklist): string {
  return checklist.items
    .map((item) => {
      const tags = `${item.importance}·${item.volatility}·${item.status}`;
      return `[${item.id}·${tags}] ${item.fact}`;
    })
    .join("\n");
}
