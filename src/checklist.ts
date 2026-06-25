import { generateObject } from "ai";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { todayLine } from "./prompts.js";
import type { RunCtx } from "./state.js";
import { withTraceFrame } from "./trace.js";

const SEED_MAX_TOKENS = 3072;
const SEED_MAX_SLOTS = 14;
const EXPANSION_MAX_ITEMS = 8;

export type SlotShape =
  | "value"
  | "range"
  | "split"
  | "causal"
  | "matrix"
  | "verdict";
export type SlotKind = "fact" | "analysis";
export type SlotImportance = "central" | "peripheral";
export type SlotStatus = "open" | "filled" | "exhausted";
export type LedgerScope = "single_fact" | "short_answer" | "broad";

export type Fill =
  | { kind: "grounded"; value: string; quote: string; source: string }
  | { kind: "computed"; value: string; computedFrom: string[] }
  | { kind: "given"; value: string }
  | { kind: "stated" }
  | { kind: "exhausted"; reason: string };

export interface Slot {
  id: string;
  ask: string;
  shape: SlotShape;
  kind: SlotKind;
  importance: SlotImportance;
  parent?: string;
  fill: Fill | null;
}

export interface Ledger {
  slots: Slot[];
  nextId: number;
  scope: LedgerScope;
}

export interface NewSlotSpec {
  ask: string;
  shape: SlotShape;
  kind: SlotKind;
  importance: SlotImportance;
  parent?: string;
}

export interface CoverageUpdate {
  closedIds: string[];
  newItems: NewSlotSpec[];
  exhaustedIds?: string[];
}

const SHAPE_VALUES = [
  "value",
  "range",
  "split",
  "causal",
  "matrix",
  "verdict",
] as const;

const slotSeedSchema = z.object({
  ask: z
    .string()
    .describe(
      "The question this slot must answer, phrased value-AGNOSTICALLY — name what to establish, never a guessed answer. Write 'operating margin for FY2024' or 'the statute section that governs X', NOT 'operating margin was 6%'. Invent no numbers.",
    ),
  shape: z
    .enum(SHAPE_VALUES)
    .describe(
      "How a thorough answer to this slot renders — this sets how deep the writer goes. " +
        "value: one figure, name, date, or identifier. " +
        "range: a band or distribution — low/typical/high and what makes it vary. " +
        "split: a breakdown into parts that sum or partition — per segment, period, channel, or category. " +
        "causal: a mechanism or chain — what drives what and why, not just the endpoint. " +
        "matrix: one entity scored on shared dimensions — a row in a comparison grid. " +
        "verdict: a categorical call — a recommendation, ranking, or yes/no with its defense.",
    ),
  kind: z
    .enum(["fact", "analysis"])
    .describe(
      "fact = a specific sub-fact to GROUND with a cited source. analysis = a comparative or synthetic move to MAKE by reasoning over grounded facts.",
    ),
  importance: z
    .enum(["central", "peripheral"])
    .describe(
      "central = the answer fails without it; peripheral = useful context.",
    ),
});

const seedSchema = z.object({
  scope: z
    .enum(["single_fact", "short_answer", "broad"])
    .describe(
      "the shape a complete answer should take: single_fact = a lookup with essentially one answer (a 1-3 sentence answer-first paragraph, no headers); short_answer = a focused question (a few tight paragraphs); broad = a survey, comparison, or multi-part question (a full structured report).",
    ),
  slots: z.array(slotSeedSchema).max(SEED_MAX_SLOTS),
});

export const newSlotSchema = z.object({
  ask: z.string(),
  shape: z.enum(SHAPE_VALUES),
  kind: z.enum(["fact", "analysis"]),
  importance: z.enum(["central", "peripheral"]),
});

export const draftCoverageSchema = z.object({
  groundedIds: z.array(z.string()),
  exhaustedIds: z.array(z.string()),
  newItems: z.array(newSlotSchema).max(EXPANSION_MAX_ITEMS),
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

const GUESSED_VALUE_RE = new RegExp(
  [
    "\\$\\s?\\d[\\d,]*(?:\\.\\d+)?",
    "\\b\\d+(?:\\.\\d+)?\\s?[–-]\\s?\\d+(?:\\.\\d+)?\\s?%?",
    "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?",
    "\\b\\d+\\.\\d+\\s?%?",
    "\\b\\d[\\d,]*\\s?%",
  ].join("|"),
  "g",
);

export function stripGuessedValues(ask: string): string {
  return ask
    .replace(GUESSED_VALUE_RE, "")
    .replace(/\(\s*[~≈]?\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
}

const SEED_SYSTEM =
  "You are the lead planner of a deep-research run. Before any source is read, lay out the LEDGER: the set of questions a complete, correct answer must resolve — the run's contract. " +
  "Each slot is a QUESTION to answer from sources, never an answer itself. Name what must be established — the entity, and the operation, period, or basis it applies to — and STOP there. Do not write a value: no number, percentage, dollar figure, or guessed name belongs in an ask. You have read nothing yet, so any figure you write is a guess that ships and grades as wrong. (Write 'Vayeron's operating margin for FY2024', never 'Vayeron's operating margin (~6%)'.) " +
  "Enumerate two kinds of slot. kind=fact: a specific sub-fact the run must GROUND with a cited source — a name, value, date, entity, mechanism, or event. kind=analysis: a comparative or synthetic move the answer must MAKE — a cross-cutting comparison, a tension that drives the topic, a synthesis across cases, or how one thing determines another. Analysis is reasoning over the grounded facts, not things to cite. " +
  "Give every slot a SHAPE — how its answer renders — because the shape is what makes a report deep instead of a flat list of values: value (one figure/name/date), range (a band and what drives it), split (a breakdown into parts that sum), causal (a mechanism/chain), matrix (one entity on shared dimensions), verdict (a categorical call with its defense). Pick the shape a thorough answer to that slot actually takes; reach for range/split/causal/matrix wherever the question rewards depth, not value everywhere. " +
  "Name the specific INSTANCE one level more concrete than the question's wording — the actual program, standard, statute section, entity, or headline metric a domain expert expects, not the category. When you name a specific instance the question did not give, that ask is one to CONFIRM OR CORRECT from sources, never a premise the report must defend, and never a license to cite sources outside the question's scope. When the question spans several entities or domains, give each its own slots rather than one bucket line; for a comparison, give each entity a matrix slot on the SAME dimensions so they line up. When the question weighs options or asks which / whether / A-versus-B / what-to-do, add a verdict slot for the call AND a slot for the fallback when the preferred option is unavailable. " +
  "Enumerate the STANDARD deliverable a domain expert would demand around the question's entry point: for a clinical question, the standard-of-care safety actions and the red-flag thresholds that trigger escalation; for a financial question, the full-period figures and the standard tables, not only the one line asked about; for an academic or comparative question, the expected sections and the authorities to cite. The question names the entry point; a complete answer is what the field expects around it. " +
  "Phrase any safety-critical slot — stopping or holding a medication or exposure, restricting an activity, an emergency threshold — as a categorical question of what to do now and on whose authority, never a hedged 'reduce if appropriate' option. " +
  "Be specific but not bloated: enough slots to cover what the question and its field demand, with no padding of near-duplicates — depth comes from each slot's shape, not from slot count. Order the slots most central first, classify the deliverable's scope, and return structured output only.";

export async function seedLedger(
  rctx: RunCtx,
  grant: BudgetGrant,
): Promise<Ledger | null> {
  if (grant.floored()) return null;
  try {
    const result = await withTraceFrame(rctx.recorder, { site: "seed" }, () =>
      generateObject({
        model: rctx.bindModel("lead", grant),
        system: SEED_SYSTEM,
        prompt:
          `${todayLine(rctx.todayISO)}\n\n` +
          `Research question: ${rctx.question}\n\n` +
          "Lay out the ledger: the questions a complete answer must resolve, each value-agnostic (no guessed numbers, no names asserted as facts), each tagged with its shape, kind, and importance. Name the concrete instance, give each entity its own slots, and reach for the shape that makes each answer deep. Classify the scope.",
        schema: seedSchema,
        maxOutputTokens: SEED_MAX_TOKENS,
        maxRetries: MODEL_CALL_MAX_RETRIES,
        abortSignal: rctx.signal,
      }),
    );
    const slots: Slot[] = result.object.slots
      .map((s, index) => ({
        id: `slot_${index + 1}`,
        ask: stripGuessedValues(s.ask),
        shape: s.shape,
        kind: s.kind,
        importance: s.importance,
        fill: null as Fill | null,
      }))
      .filter((slot) => slot.ask.length > 0);
    if (slots.length === 0) return null;
    return { slots, nextId: slots.length + 1, scope: result.object.scope };
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return null;
  }
}

export function ledgerFromSubQuestions(
  subQuestions: string[],
): Ledger | null {
  const slots: Slot[] = subQuestions
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, SEED_MAX_SLOTS)
    .map((ask, index) => ({
      id: `slot_${index + 1}`,
      ask: stripGuessedValues(ask),
      shape: "value" as SlotShape,
      kind: "fact" as SlotKind,
      importance: "central" as SlotImportance,
      fill: null,
    }));
  if (slots.length === 0) return null;
  return { slots, nextId: slots.length + 1, scope: "broad" };
}

export function findSlot(ledger: Ledger, id: string): Slot | undefined {
  const key = id.trim();
  return ledger.slots.find((slot) => slot.id === key);
}

export function addSlot(ledger: Ledger, spec: NewSlotSpec): Slot {
  const slot: Slot = {
    id: `slot_${ledger.nextId++}`,
    ask: stripGuessedValues(spec.ask),
    shape: spec.shape,
    kind: spec.kind,
    importance: spec.importance,
    ...(spec.parent ? { parent: spec.parent } : {}),
    fill: null,
  };
  ledger.slots.push(slot);
  return slot;
}

export function applyCoverageUpdate(
  ledger: Ledger,
  update: CoverageUpdate,
): void {
  const closed = new Set(update.closedIds);
  const exhausted = new Set(update.exhaustedIds ?? []);
  for (const slot of ledger.slots) {
    if (slot.fill) continue;
    if (exhausted.has(slot.id)) {
      slot.fill = { kind: "exhausted", reason: "searched and dead-ended" };
    } else if (closed.has(slot.id)) {
      slot.fill = { kind: "stated" };
    }
  }
  const known = new Set(
    ledger.slots.map((slot) => slot.ask.trim().toLowerCase()),
  );
  for (const raw of update.newItems) {
    const ask = stripGuessedValues(raw.ask);
    if (!ask || known.has(ask.toLowerCase())) continue;
    known.add(ask.toLowerCase());
    ledger.slots.push({
      id: `slot_${ledger.nextId++}`,
      ask,
      shape: raw.shape,
      kind: raw.kind,
      importance: raw.importance,
      fill: null,
    });
  }
}

export function slotStatus(slot: Slot): SlotStatus {
  if (!slot.fill) return "open";
  if (slot.fill.kind === "exhausted") return "exhausted";
  return "filled";
}

export function openItems(ledger: Ledger): Slot[] {
  return ledger.slots.filter((slot) => !slot.fill);
}

export function isAnswered(ledger: Ledger): boolean {
  return !ledger.slots.some(
    (slot) =>
      !slot.fill && slot.importance === "central" && slot.kind === "fact",
  );
}

export function centralFactsAllFilled(ledger: Ledger): boolean {
  const central = ledger.slots.filter(
    (slot) => slot.importance === "central" && slot.kind === "fact",
  );
  if (central.length === 0) return false;
  return central.every(
    (slot) => slot.fill !== null && slot.fill.kind !== "exhausted",
  );
}

function fillValue(fill: Fill): string | null {
  switch (fill.kind) {
    case "grounded":
      return `${fill.value} [${fill.source}]`;
    case "computed":
      return `${fill.value} [computed from ${fill.computedFrom.join(", ")}]`;
    case "given":
      return `${fill.value} [given in the question]`;
    case "stated":
    case "exhausted":
      return null;
  }
}

export function renderGatherContract(ledger: Ledger): string {
  const facts = ledger.slots.filter((slot) => slot.kind === "fact");
  const analysis = ledger.slots.filter((slot) => slot.kind === "analysis");
  const line = (slot: Slot) =>
    `- [${slot.id} · ${slot.importance} · ${slot.shape}] ${slot.ask}`;
  const blocks: string[] = [];
  if (facts.length > 0) {
    blocks.push(
      "Facts to establish from fetched sources, then close with close_slot(slot_id, value, source_id, quote):\n" +
        facts.map(line).join("\n"),
    );
  }
  if (analysis.length > 0) {
    blocks.push(
      "Analytical moves to work out across the sources, then close with close_slot (the value is your reasoned or computed conclusion):\n" +
        analysis.map(line).join("\n"),
    );
  }
  return blocks.join("\n\n");
}

export function renderLedgerAudit(ledger: Ledger): string {
  return ledger.slots
    .map((slot) => {
      const status = slotStatus(slot);
      const value = slot.fill ? fillValue(slot.fill) : null;
      const tail = value
        ? ` -> ${value}`
        : slot.fill && slot.fill.kind === "exhausted"
          ? ` -> exhausted: ${slot.fill.reason}`
          : "";
      return `[${slot.id}·${slot.importance}·${slot.shape}·${status}] ${slot.ask}${tail}`;
    })
    .join("\n");
}

export function renderOpenSlots(ledger: Ledger): string {
  const open = ledger.slots.filter(
    (slot) => !slot.fill && slot.kind === "fact",
  );
  if (open.length === 0) return "";
  return (
    "Still-open facts to close once grounded (close_slot):\n" +
    open
      .map(
        (slot) =>
          `- [${slot.id} · ${slot.importance} · ${slot.shape}] ${slot.ask}`,
      )
      .join("\n")
  );
}

const SHAPE_RENDER_LEGEND: Record<SlotShape, string> = {
  value: "state the figure, name, or date directly, in its exact form",
  range:
    "give the band — low to high, with what drives the variation — not a lone midpoint",
  split:
    "break it into the parts that sum or partition it (per segment, period, or channel), not just the total",
  causal:
    "trace the mechanism — what drives what, and why — not only the endpoint",
  matrix:
    "state this entity on each shared dimension so it lines up against its peers in one comparison",
  verdict:
    "commit to the call and defend it from the evidence; never retreat to a balanced non-answer",
};

export function renderDeliverableContract(ledger: Ledger): string {
  const filled = ledger.slots.filter(
    (slot) => slot.fill && fillValue(slot.fill) !== null,
  );
  if (filled.length === 0) return "";
  const shapesPresent = [...new Set(filled.map((slot) => slot.shape))];
  const legend = shapesPresent
    .map((shape) => `- ${shape}: ${SHAPE_RENDER_LEGEND[shape]}`)
    .join("\n");
  const lines = filled.map(
    (slot) => `- [${slot.shape}] ${slot.ask} -> ${fillValue(slot.fill!)}`,
  );
  return (
    "DELIVERABLE CONTRACT — these are the findings your report is judged on. State each plainly and up front; never bury, hedge, or silently drop one you hold. Render each to the depth its shape calls for:\n" +
    legend +
    "\n\nFindings:\n" +
    lines.join("\n")
  );
}

export function renderDeliverableShape(ledger: Ledger): string {
  switch (ledger.scope) {
    case "single_fact":
      return "DELIVERABLE SHAPE: a single-fact lookup. Lead with the direct answer in its shortest canonical form, keep it to 1-3 sentences, and use NO section headers. Do not expand it into a multi-section report.";
    case "short_answer":
      return "DELIVERABLE SHAPE: a focused question. Lead with the bottom-line answer, then a few tight paragraphs; add headers only where they genuinely help.";
    default:
      return "DELIVERABLE SHAPE: a broad question. A full structured report fits. Open with a brief bottom-line, then the structured detail; do not pad with re-derivation of the same point.";
  }
}
