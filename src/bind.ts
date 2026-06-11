import { generateObject } from "ai";
import { z } from "zod";
import { mapWithConcurrency } from "./async.js";
import type { BudgetGrant } from "./budget.js";
import { quoteAppearsInSource, type ResearchClaim } from "./ledger.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { RunCtx } from "./state.js";
import { quoteContext } from "./synthesize.js";

export interface Citation {
  sentenceSpan: [number, number];
  claimId: string;
  sourceId: string;
  quote: string;
  verified: boolean;
}

export interface BindOutcome {
  report: string;
  citations: Citation[];
  citationsBound: number;
  citationsUnsupported: number;
  unsupportedSentences: string[];
}

const MARKER_REGEX = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ENTAILMENT_BATCH_SIZE = 20;
const ENTAILMENT_BATCH_CONCURRENCY = 4;
const MAX_UNMARKED_CLASSIFIED = 60;
const MIN_FACTUAL_SENTENCE_CHARS = 40;

interface MarkerSite {
  claimIds: string[];
  pos: number;
}

export function stripMarkers(draft: string): {
  report: string;
  markers: MarkerSite[];
} {
  let stripped = "";
  let lastIndex = 0;
  const markers: MarkerSite[] = [];
  for (const match of draft.matchAll(MARKER_REGEX)) {
    stripped += draft.slice(lastIndex, match.index);
    while (stripped.endsWith(" ")) stripped = stripped.slice(0, -1);
    const ids = match[1]
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^claim_\w+$/.test(id));
    if (ids.length > 0) {
      markers.push({ claimIds: ids, pos: stripped.length });
    }
    lastIndex = (match.index ?? 0) + match[0].length;
    while (draft[lastIndex] === " " && stripped.endsWith("\n")) lastIndex++;
  }
  stripped += draft.slice(lastIndex);
  return { report: stripped, markers };
}

function sentenceSpanEndingAt(
  text: string,
  end: number,
): [number, number] {
  let start = 0;
  for (let i = end - 2; i >= 0; i--) {
    const char = text[i];
    if (char === "\n" || char === "." || char === "!" || char === "?") {
      start = i + 1;
      break;
    }
  }
  while (start < end && /\s/.test(text[start])) start++;
  return [start, end];
}

const entailmentSchema = z.object({
  checks: z.array(
    z.object({
      index: z.number().int(),
      supported: z.boolean(),
    }),
  ),
});

const factualSchema = z.object({
  factual: z.array(z.number().int()),
});

interface EntailmentItem {
  index: number;
  sentence: string;
  claim: ResearchClaim;
  context?: string | undefined;
}

async function runEntailmentChecks(
  rctx: RunCtx,
  grant: BudgetGrant,
  items: EntailmentItem[],
): Promise<Map<number, boolean>> {
  const supported = new Map<number, boolean>();
  if (items.length === 0) return supported;
  const model = rctx.bindModel("verify", grant);
  const batches: EntailmentItem[][] = [];
  for (
    let offset = 0;
    offset < items.length;
    offset += ENTAILMENT_BATCH_SIZE
  ) {
    batches.push(items.slice(offset, offset + ENTAILMENT_BATCH_SIZE));
  }
  await mapWithConcurrency(batches, ENTAILMENT_BATCH_CONCURRENCY, async (batch) => {
    if (grant.floored()) return;
    const prompt =
      "For each numbered item, judge whether the report sentence is entailed by the claim, its verbatim source quote, and (when given) the quote's surrounding source context — i.e. every factual assertion in the sentence is supported by them. Judge entailment only; ignore style.\n\n" +
      batch
        .map(
          (item) =>
            `[${item.index}]\nSentence: "${item.sentence}"\nClaim: "${item.claim.text}"\nQuote: "${item.claim.quote}"` +
            (item.context
              ? `\nSource context around the quote: "${item.context}"`
              : ""),
        )
        .join("\n\n") +
      "\n\nReturn one verdict per index.";
    try {
      const result = await generateObject({
        model,
        system:
          "You check whether report sentences are entailed by their cited claims for a research run. Structured output only.",
        prompt,
        schema: entailmentSchema,
        maxOutputTokens: 2_000,
        maxRetries: MODEL_CALL_MAX_RETRIES,
        abortSignal: rctx.signal,
      });
      for (const check of result.object.checks) {
        supported.set(check.index, check.supported);
      }
    } catch (err) {
      if (rctx.signal?.aborted) throw err;
    }
  });
  return supported;
}

async function classifyUnmarkedSentences(
  rctx: RunCtx,
  grant: BudgetGrant,
  sentences: string[],
): Promise<Set<number>> {
  if (sentences.length === 0 || grant.floored()) return new Set();
  const model = rctx.bindModel("verify", grant);
  const prompt =
    "These sentences from a research report carry no citation. List the indices of sentences that assert a checkable factual claim about the world (numbers, dates, named entities, events, study results). Skip headings, transitions, opinions, summaries of cited material, and meta statements.\n\n" +
    sentences.map((sentence, index) => `[${index}] ${sentence}`).join("\n") +
    "\n\nReturn the factual indices.";
  try {
    const result = await generateObject({
      model,
      system:
        "You triage uncited report sentences for a citation audit. Structured output only.",
      prompt,
      schema: factualSchema,
      maxOutputTokens: 1_000,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    });
    return new Set(
      result.object.factual.filter(
        (index) => index >= 0 && index < sentences.length,
      ),
    );
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
    return new Set();
  }
}

function unmarkedSentences(
  report: string,
  markerSpans: Array<[number, number]>,
): string[] {
  const sentences: string[] = [];
  const segments = report.split(/\n+/);
  let offset = 0;
  for (const segment of segments) {
    const segmentStart = report.indexOf(segment, offset);
    offset = segmentStart + segment.length;
    if (segment.trim().startsWith("#")) continue;
    let cursor = 0;
    for (const piece of segment.split(/(?<=[.!?])\s+/)) {
      const pieceStart = segmentStart + segment.indexOf(piece, cursor);
      cursor = pieceStart - segmentStart + piece.length;
      const pieceEnd = pieceStart + piece.length;
      const trimmed = piece.trim();
      if (trimmed.length < MIN_FACTUAL_SENTENCE_CHARS) continue;
      const covered = markerSpans.some(
        ([start, end]) => pieceStart < end && pieceEnd > start,
      );
      if (!covered) sentences.push(trimmed);
    }
  }
  return sentences.slice(0, MAX_UNMARKED_CLASSIFIED);
}

export async function bindCitations(
  rctx: RunCtx,
  grant: BudgetGrant,
  draft: string,
): Promise<BindOutcome> {
  const { report, markers } = stripMarkers(draft);
  const citations: Citation[] = [];
  const entailmentItems: EntailmentItem[] = [];
  const markerSpans: Array<[number, number]> = [];

  let itemIndex = 0;
  for (const marker of markers) {
    const span = sentenceSpanEndingAt(report, marker.pos);
    markerSpans.push(span);
    const sentence = report.slice(span[0], span[1]).trim();
    for (const claimId of marker.claimIds) {
      const rawClaim = rctx.ledger.byId(claimId);
      if (!rawClaim) continue;
      const claim = rawClaim.duplicateOf
        ? (rctx.ledger.byId(rawClaim.duplicateOf) ?? rawClaim)
        : rawClaim;
      const document = rctx.sources.byId.get(claim.sourceId);
      const quoteOk = document
        ? quoteAppearsInSource(claim.quote, document.markdown)
        : false;
      citations.push({
        sentenceSpan: span,
        claimId: claim.id,
        sourceId: claim.sourceId,
        quote: claim.quote,
        verified: quoteOk,
      });
      if (quoteOk && rctx.config.envelope.maxEntailmentChecks > 0) {
        entailmentItems.push({
          index: itemIndex,
          sentence,
          claim,
          context: quoteContext(rctx, claim),
        });
      }
      itemIndex++;
    }
  }

  const cappedItems = entailmentItems.slice(
    0,
    rctx.config.envelope.maxEntailmentChecks,
  );
  const entailment = await runEntailmentChecks(rctx, grant, cappedItems);
  for (const item of cappedItems) {
    const verdict = entailment.get(item.index);
    if (verdict === false) {
      citations[item.index] = { ...citations[item.index], verified: false };
    }
  }

  for (const citation of citations) {
    rctx.emit({
      type: "citation.bound",
      claimId: citation.claimId,
      sentence: report
        .slice(citation.sentenceSpan[0], citation.sentenceSpan[1])
        .slice(0, 200),
      ok: citation.verified,
    });
  }

  const uncited = unmarkedSentences(report, markerSpans);
  const factualIndices =
    rctx.config.envelope.maxEntailmentChecks > 0
      ? await classifyUnmarkedSentences(rctx, grant, uncited)
      : new Set<number>();
  const unsupportedSentences = [...factualIndices]
    .sort((a, b) => a - b)
    .map((index) => uncited[index]);

  return {
    report,
    citations,
    citationsBound: citations.filter((citation) => citation.verified).length,
    citationsUnsupported:
      citations.filter((citation) => !citation.verified).length +
      unsupportedSentences.length,
    unsupportedSentences,
  };
}
