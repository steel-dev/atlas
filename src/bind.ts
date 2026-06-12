import { generateObject } from "ai";
import { z } from "zod";
import { mapWithConcurrency } from "./async.js";
import type { BudgetGrant } from "./budget.js";
import {
  quoteSupportedByDocument,
  type ClaimStatus,
  type ResearchClaim,
} from "./ledger.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { RunCtx } from "./state.js";
import { quoteContext } from "./synthesize.js";

export interface Citation {
  sentenceSpan: [number, number];
  claimId: string;
  sourceId: string;
  quote: string;
  status?: ClaimStatus;
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

const STREAM_MARKER_REGEX = /[ \t]*\{\{[^{}]*\}\}/g;
const STREAM_HOLDBACK_REGEX = /[ \t]*(?:\{|\{\{[^{}]{0,80}\}?)?$/;

export interface MarkerStripper {
  push(chunk: string): string;
  flush(): string;
}

export function createMarkerStripper(): MarkerStripper {
  let pending = "";
  return {
    push(chunk) {
      pending = (pending + chunk).replace(STREAM_MARKER_REGEX, "");
      const hold = STREAM_HOLDBACK_REGEX.exec(pending)?.index ?? pending.length;
      const out = pending.slice(0, hold);
      pending = pending.slice(hold);
      return out;
    },
    flush() {
      const out = pending.replace(STREAM_MARKER_REGEX, "");
      pending = "";
      return out;
    },
  };
}

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "no",
  "vs",
  "etc",
  "approx",
  "dept",
  "est",
  "fig",
  "vol",
  "inc",
  "ltd",
  "co",
  "corp",
  "al",
  "eg",
  "ie",
  "cf",
  "ca",
  "pp",
]);

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char === "\n" || char === "!" || char === "?") return true;
  if (char !== ".") return false;
  const next = text[index + 1];
  if (next !== undefined && !/[\s")”’]/.test(next)) return false;
  if (text[index - 1] === "." || next === ".") return false;
  const before = text.slice(Math.max(0, index - 24), index);
  const token = /(\S+)$/.exec(before)?.[1] ?? "";
  const word = token.replace(/^[("'“‘[]+/, "");
  if (/^[A-Z]$/.test(word)) return false;
  if (word.includes(".")) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  return true;
}

function sentenceSpanEndingAt(
  text: string,
  end: number,
): [number, number] {
  let start = 0;
  for (let i = end - 2; i >= 0; i--) {
    if (isSentenceBoundary(text, i)) {
      start = i + 1;
      break;
    }
  }
  while (start < end && /\s/.test(text[start])) start++;
  return [start, end];
}

function splitSentences(segment: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < segment.length; i++) {
    if (
      /[.!?]/.test(segment[i]) &&
      /\s/.test(segment[i + 1] ?? "") &&
      isSentenceBoundary(segment, i)
    ) {
      pieces.push(segment.slice(start, i + 1));
      i++;
      while (i < segment.length && /\s/.test(segment[i])) i++;
      start = i;
      i--;
    }
  }
  if (start < segment.length) pieces.push(segment.slice(start));
  return pieces;
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
    for (const piece of splitSentences(segment)) {
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

  for (const marker of markers) {
    const span = sentenceSpanEndingAt(report, marker.pos);
    markerSpans.push(span);
    const sentence = report.slice(span[0], span[1]).trim();
    for (const claimId of marker.claimIds) {
      const rawClaim = rctx.ledger.byId(claimId);
      if (!rawClaim) {
        citations.push({
          sentenceSpan: span,
          claimId,
          sourceId: "",
          quote: "",
          verified: false,
        });
        continue;
      }
      const claim = rawClaim.duplicateOf
        ? (rctx.ledger.byId(rawClaim.duplicateOf) ?? rawClaim)
        : rawClaim;
      const document = rctx.sources.byId.get(claim.sourceId);
      const quoteOk = document
        ? quoteSupportedByDocument(claim.quote, document)
        : false;
      const verified = quoteOk && claim.status !== "refuted";
      citations.push({
        sentenceSpan: span,
        claimId: claim.id,
        sourceId: claim.sourceId,
        quote: claim.quote,
        status: claim.status,
        verified,
      });
      if (verified && rctx.config.envelope.maxEntailmentChecks > 0) {
        entailmentItems.push({
          index: citations.length - 1,
          sentence,
          claim,
          context: quoteContext(rctx, claim),
        });
      }
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
