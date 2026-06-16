import { generateObject } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { z } from "zod";
import { createConcurrencyGate } from "./async.js";
import { adoptVerdictsOnMerge, QUALITY_RANK } from "./claim-status.js";
import { errorMessage } from "./errors.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { QUARANTINE_NOTE, quarantine } from "./safety.js";
import { selectExtractionWindow } from "./source-documents.js";
import type { ResearchEvent } from "./events.js";
import type { SourceDocument } from "./sources.js";

export type ClaimImportance = "central" | "supporting" | "tangential";

export type ClaimSourceQuality =
  | "primary"
  | "secondary"
  | "blog"
  | "forum"
  | "unreliable";

export type ClaimStatus =
  | "confirmed"
  | "screened"
  | "contested"
  | "refuted"
  | "unverified";

export type ClaimConfidence = "high" | "medium" | "low";

export interface ClaimVote {
  lens: string;
  refuted: boolean;
  evidence: string;
  confidence: ClaimConfidence;
}

export interface ResearchClaim {
  id: string;
  text: string;
  quote: string;
  importance: ClaimImportance;
  sourceQuality: ClaimSourceQuality;
  sourceId: string;
  url: string;
  title: string;
  publishedTime?: string;
  status: ClaimStatus;
  votes: ClaimVote[];
  agentId: string;
  duplicateOf?: string;
  corroboration?: number;
  corroboratingSources?: string[];
  conflictsWith?: string[];
}

const DEFAULT_EXTRACTION_INPUT_CHARS = 40_000;
const EXTRACTION_BASE_TOKENS = 500;
const EXTRACTION_TOKENS_PER_CLAIM = 300;
const DEFAULT_CLAIMS_PER_SOURCE = 5;
const EXTRACTION_CONCURRENCY = 8;
const MIN_EXTRACTABLE_CHARS = 200;
const LEDGER_DIGEST_MAX_CLAIMS = 60;
export const NON_EVIDENCE_WARNINGS =
  /\b(?:blocked_or_challenge|thin_content|error_page|search_listing_page)\b/i;

const IMPORTANCE_VALUES = ["central", "supporting", "tangential"] as const;
const QUALITY_VALUES = [
  "primary",
  "secondary",
  "blog",
  "forum",
  "unreliable",
] as const;

function extractionSchema(maxClaims: number) {
  return z.object({
    sourceQuality: z.enum(QUALITY_VALUES),
    publishDate: z.string().optional(),
    claims: z
      .array(
        z.object({
          claim: z.string(),
          quote: z.string(),
          importance: z.enum(IMPORTANCE_VALUES),
        }),
      )
      .max(maxClaims),
  });
}

const EXTRACTION_SYSTEM_PROMPT =
  "You extract falsifiable, verbatim-quoted claims from one fetched source document for a research run. " +
  QUARANTINE_NOTE;

function extractionPrompt(
  goal: string,
  document: SourceDocument,
  maxClaims: number,
  inputChars: number,
): string {
  const window = selectExtractionWindow(document, goal, inputChars);
  const text = window.text;
  const truncationNote = window.truncated
    ? `\n(Source is ${document.markdown.length} characters; showing the ${text.length} most relevant to the research goal. "[…]" marks omitted spans — quote only from the text shown above.)`
    : "";
  return (
    "## Source claim extractor\n\n" +
    `Research goal: "${goal}"\n\n` +
    "Source:\n" +
    `- URL: ${document.url}\n` +
    `- Title: ${document.title}\n` +
    `- Published: ${document.metadata.publishedTime ?? "unknown"}\n\n` +
    "Source text:\n" +
    quarantine(text, { sourceId: document.sourceId, url: document.url }) +
    truncationNote +
    "\n\n## Task\n" +
    '1. Assess source quality: primary research/official/institutional data → "primary"; reputable secondary reporting → "secondary"; personal blog or opinion → "blog"; forum or user-generated content → "forum"; spam, ads, or pages irrelevant to the goal → "unreliable". A paywalled stub or preview keeps the publisher\'s quality grade — just extract only what the visible text supports.\n' +
    `2. Extract 2-${maxClaims} falsifiable claims that bear on the research goal. Each claim must:\n` +
    "   - be a concrete, checkable statement that preserves exact values, dates, and named entities\n" +
    "   - include a supporting quote copied VERBATIM from the source text above — it is string-matched against the stored text, so never paraphrase, correct, reorder, or splice\n" +
    "   - be rated central, supporting, or tangential to the research goal\n" +
    "3. Record the publish date if the text states one.\n\n" +
    "If the source is irrelevant, empty, or low-value, return claims: [] with the appropriate sourceQuality."
  );
}

export function normalizeForQuoteMatch(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function quoteSupportedIn(normalizedSource: string, quote: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  return (
    normalizedQuote.length > 0 && normalizedSource.includes(normalizedQuote)
  );
}

export function quoteAppearsInSource(
  quote: string,
  sourceText: string,
): boolean {
  return quoteSupportedIn(normalizeForQuoteMatch(sourceText), quote);
}

const normalizedSourceCache = new WeakMap<SourceDocument, string>();

function normalizedSourceText(document: SourceDocument): string {
  let cached = normalizedSourceCache.get(document);
  if (cached === undefined) {
    cached = normalizeForQuoteMatch(document.markdown);
    normalizedSourceCache.set(document, cached);
  }
  return cached;
}

export function quoteSupportedByDocument(
  quote: string,
  document: SourceDocument,
): boolean {
  return quoteSupportedIn(normalizedSourceText(document), quote);
}

const MIRROR_MIN_SEGMENTS = 8;
const MIRROR_MIN_SEGMENT_CHARS = 60;
const MIRROR_OVERLAP_THRESHOLD = 0.8;

function hashSegment(segment: string): number {
  let hash = 5381;
  for (let i = 0; i < segment.length; i++) {
    hash = ((hash << 5) + hash + segment.charCodeAt(i)) | 0;
  }
  return hash;
}

export function contentSignature(markdown: string): Set<number> {
  const hashes = new Set<number>();
  for (const raw of markdown.split(/[.!?\n]+/)) {
    const segment = normalizeForQuoteMatch(raw);
    if (segment.length < MIRROR_MIN_SEGMENT_CHARS) continue;
    hashes.add(hashSegment(segment));
  }
  return hashes;
}

function signatureOverlap(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const hash of small) if (large.has(hash)) shared++;
  return shared / small.size;
}

function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function registrableHost(url: string): string {
  return shortHost(url).toLowerCase();
}

export function renderLedgerDigest(
  claims: ResearchClaim[],
  maxClaims = LEDGER_DIGEST_MAX_CLAIMS,
): string {
  const representatives = claims.filter((claim) => !claim.duplicateOf);
  const lines = representatives.slice(0, maxClaims).map((claim) => {
    const statusTag = claim.status === "unverified" ? "" : `·${claim.status}`;
    const corroboration =
      claim.corroboration && claim.corroboration > 1
        ? ` (×${claim.corroboration} sources)`
        : "";
    return `[${claim.id}·${claim.importance}·${claim.sourceQuality}${statusTag}] ${claim.text} — ${shortHost(claim.url)} (${claim.sourceId})${corroboration}`;
  });
  if (representatives.length > maxClaims) {
    lines.push(
      `…and ${representatives.length - maxClaims} more claims (inspect their sources with search_sources/read_source)`,
    );
  }
  return lines.join("\n");
}

export interface LedgerQueueOptions {
  goal: string;
  agentId: string;
  model: LanguageModelV3;
}

export interface LedgerAddClaimInput {
  text: string;
  quote: string;
  importance: ClaimImportance;
  agentId: string;
}

export type LedgerAddClaimResult =
  | { outcome: "added"; claim: ResearchClaim }
  | { outcome: "corroborated"; representativeId: string }
  | { outcome: "duplicate"; representativeId: string }
  | { outcome: "unsupported" };

export interface Ledger {
  readonly claims: ResearchClaim[];
  readonly unsupportedCount: number;
  readonly dupesDropped: number;
  queue(document: SourceDocument, opts: LedgerQueueOptions): void;
  addClaim(
    document: SourceDocument,
    input: LedgerAddClaimInput,
  ): LedgerAddClaimResult;
  settle(): Promise<void>;
  flush(agentId?: string): Promise<void>;
  merge(duplicateId: string, intoId: string): boolean;
  byId(claimId: string): ResearchClaim | undefined;
  representatives(): ResearchClaim[];
  digest(maxClaims?: number): string;
}

export interface LedgerContext {
  emit(event: ResearchEvent): void;
  signal?: AbortSignal | undefined;
  shouldExtract(): boolean;
  onClaim?(claim: ResearchClaim): void;
  claimsPerSource?: number;
  extractionChars?: number;
}

interface RawExtractedClaim {
  claim: string;
  quote: string;
  importance: ClaimImportance;
}

function isEvidenceSource(document: SourceDocument): boolean {
  if (document.markdown.length < MIN_EXTRACTABLE_CHARS) return false;
  const warnings = document.metadata.qualityWarnings ?? [];
  return !warnings.some((warning) => NON_EVIDENCE_WARNINGS.test(warning));
}

export function createLedger(ctx: LedgerContext): Ledger {
  const claims: ResearchClaim[] = [];
  const claimsById = new Map<string, ResearchClaim>();
  const representativeByText = new Map<string, string>();
  const queuedSourceIds = new Set<string>();
  const pending = new Set<{ task: Promise<void>; agentId: string }>();
  const gate = createConcurrencyGate(EXTRACTION_CONCURRENCY);
  const sourceSignatures = new Map<string, Set<number>>();
  const mirrorCanonical = new Map<string, string>();
  let nextClaimNumber = 1;
  let unsupportedCount = 0;
  let dupesDropped = 0;

  function registerSource(document: SourceDocument): void {
    if (sourceSignatures.has(document.sourceId)) return;
    const signature = contentSignature(document.markdown);
    if (signature.size >= MIRROR_MIN_SEGMENTS) {
      for (const [sourceId, other] of sourceSignatures) {
        if (other.size < MIRROR_MIN_SEGMENTS) continue;
        if (signatureOverlap(signature, other) >= MIRROR_OVERLAP_THRESHOLD) {
          mirrorCanonical.set(
            document.sourceId,
            mirrorCanonical.get(sourceId) ?? sourceId,
          );
          break;
        }
      }
    }
    sourceSignatures.set(document.sourceId, signature);
  }

  function sameOrigin(a: ResearchClaim, b: ResearchClaim): boolean {
    return (
      a.sourceId === b.sourceId ||
      registrableHost(a.url) === registrableHost(b.url) ||
      (mirrorCanonical.get(a.sourceId) ?? a.sourceId) ===
        (mirrorCanonical.get(b.sourceId) ?? b.sourceId)
    );
  }

  function adoptBetterQuality(
    representative: ResearchClaim,
    claim: ResearchClaim,
  ): void {
    if (
      QUALITY_RANK[claim.sourceQuality] <
      QUALITY_RANK[representative.sourceQuality]
    ) {
      representative.sourceQuality = claim.sourceQuality;
    }
  }

  function admit(claim: ResearchClaim): ResearchClaim | null {
    const textKey = normalizeForQuoteMatch(claim.text);
    const existingId = representativeByText.get(textKey);
    if (!existingId) {
      claim.id = `claim_${nextClaimNumber++}`;
      representativeByText.set(textKey, claim.id);
      claims.push(claim);
      claimsById.set(claim.id, claim);
      return claim;
    }
    const representative = claimsById.get(existingId);
    if (!representative) return null;
    if (sameOrigin(representative, claim)) {
      dupesDropped++;
      return null;
    }
    const corroborating = new Set(representative.corroboratingSources ?? []);
    corroborating.add(claim.url);
    representative.corroboratingSources = [...corroborating];
    representative.corroboration = corroborating.size + 1;
    adoptBetterQuality(representative, claim);
    claim.id = `claim_${nextClaimNumber++}`;
    claim.duplicateOf = representative.id;
    claims.push(claim);
    claimsById.set(claim.id, claim);
    return null;
  }

  async function extract(
    document: SourceDocument,
    opts: LedgerQueueOptions,
  ): Promise<void> {
    const maxClaims = ctx.claimsPerSource ?? DEFAULT_CLAIMS_PER_SOURCE;
    const inputChars = ctx.extractionChars ?? DEFAULT_EXTRACTION_INPUT_CHARS;
    const result = await generateObject({
      model: opts.model,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionPrompt(opts.goal, document, maxClaims, inputChars),
      schema: extractionSchema(maxClaims),
      maxOutputTokens:
        EXTRACTION_BASE_TOKENS + EXTRACTION_TOKENS_PER_CLAIM * maxClaims,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: ctx.signal,
    });
    const extraction = result.object;
    const publishedTime =
      document.metadata.publishedTime ?? extraction.publishDate ?? undefined;
    const normalizedSource = normalizedSourceText(document);

    let added = 0;
    let unsupported = 0;
    for (const raw of extraction.claims as RawExtractedClaim[]) {
      const text = raw.claim?.trim();
      const quote = raw.quote?.trim() ?? "";
      if (!text) continue;
      if (!quoteSupportedIn(normalizedSource, quote)) {
        unsupported++;
        continue;
      }
      const claim: ResearchClaim = {
        id: "",
        text,
        quote,
        importance: raw.importance,
        sourceQuality: extraction.sourceQuality,
        sourceId: document.sourceId,
        url: document.url,
        title: document.title,
        ...(publishedTime ? { publishedTime } : {}),
        status: "unverified",
        votes: [],
        agentId: opts.agentId,
      };
      const admitted = admit(claim);
      if (admitted) {
        added++;
        ctx.emit({
          type: "claim.extracted",
          claimId: admitted.id,
          sourceId: document.sourceId,
          text: admitted.text,
          importance: admitted.importance,
        });
        ctx.onClaim?.(admitted);
      }
    }
    unsupportedCount += unsupported;
    ctx.emit({
      type: "extraction.completed",
      sourceId: document.sourceId,
      url: document.url,
      count: added,
      unsupported,
    });
  }

  function sourceQualityFor(sourceId: string): ClaimSourceQuality | undefined {
    return claims.find((claim) => claim.sourceId === sourceId)?.sourceQuality;
  }

  function addClaim(
    document: SourceDocument,
    input: LedgerAddClaimInput,
  ): LedgerAddClaimResult {
    if (!quoteSupportedByDocument(input.quote, document)) {
      unsupportedCount++;
      return { outcome: "unsupported" };
    }
    registerSource(document);
    const claim: ResearchClaim = {
      id: "",
      text: input.text,
      quote: input.quote,
      importance: input.importance,
      sourceQuality: sourceQualityFor(document.sourceId) ?? "secondary",
      sourceId: document.sourceId,
      url: document.url,
      title: document.title,
      ...(document.metadata.publishedTime
        ? { publishedTime: document.metadata.publishedTime }
        : {}),
      status: "unverified",
      votes: [],
      agentId: input.agentId,
    };
    const admitted = admit(claim);
    if (admitted) {
      ctx.emit({
        type: "claim.extracted",
        claimId: admitted.id,
        sourceId: document.sourceId,
        text: admitted.text,
        importance: admitted.importance,
      });
      ctx.onClaim?.(admitted);
      return { outcome: "added", claim: admitted };
    }
    const representativeId =
      claim.duplicateOf ??
      representativeByText.get(normalizeForQuoteMatch(claim.text)) ??
      "";
    return {
      outcome: claim.duplicateOf ? "corroborated" : "duplicate",
      representativeId,
    };
  }

  function queue(document: SourceDocument, opts: LedgerQueueOptions): void {
    if (queuedSourceIds.has(document.sourceId)) return;
    queuedSourceIds.add(document.sourceId);
    if (!isEvidenceSource(document)) return;
    if (!ctx.shouldExtract()) return;
    registerSource(document);

    const task = gate
      .run(() => extract(document, opts))
      .catch((err: unknown) => {
        if (ctx.signal?.aborted) return;
        ctx.emit({
          type: "extraction.completed",
          sourceId: document.sourceId,
          url: document.url,
          count: 0,
          unsupported: 0,
          error: errorMessage(err),
        });
      });
    const entry = { task, agentId: opts.agentId };
    pending.add(entry);
    void task.finally(() => pending.delete(entry));
  }

  async function settle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending].map((entry) => entry.task));
    }
  }

  async function flush(agentId?: string): Promise<void> {
    const tasks = [...pending]
      .filter((entry) => agentId === undefined || entry.agentId === agentId)
      .map((entry) => entry.task);
    if (tasks.length > 0) await Promise.all(tasks);
  }

  function rootOf(claim: ResearchClaim): ResearchClaim {
    let current = claim;
    const seen = new Set<string>();
    while (current.duplicateOf && !seen.has(current.id)) {
      seen.add(current.id);
      const next = claimsById.get(current.duplicateOf);
      if (!next) break;
      current = next;
    }
    return current;
  }

  function merge(duplicateId: string, intoId: string): boolean {
    const dup = claimsById.get(duplicateId);
    const target = claimsById.get(intoId);
    if (!dup || !target) return false;
    const rep = rootOf(target);
    if (dup.duplicateOf || rep.duplicateOf || dup.id === rep.id) return false;
    dup.duplicateOf = rep.id;
    for (const claim of claims) {
      if (claim !== dup && claim.duplicateOf === dup.id) {
        claim.duplicateOf = rep.id;
      }
    }
    const corroborating = new Set(rep.corroboratingSources ?? []);
    for (const url of dup.corroboratingSources ?? []) corroborating.add(url);
    if (sameOrigin(dup, rep)) dupesDropped++;
    else {
      corroborating.add(dup.url);
      adoptBetterQuality(rep, dup);
    }
    corroborating.delete(rep.url);
    if (corroborating.size > 0) {
      rep.corroboratingSources = [...corroborating];
      rep.corroboration = corroborating.size + 1;
    }
    adoptVerdictsOnMerge(rep, dup);
    representativeByText.set(normalizeForQuoteMatch(dup.text), rep.id);
    return true;
  }

  return {
    claims,
    get unsupportedCount() {
      return unsupportedCount;
    },
    get dupesDropped() {
      return dupesDropped;
    },
    queue,
    addClaim,
    settle,
    flush,
    merge,
    byId: (claimId) => claimsById.get(claimId),
    representatives: () => claims.filter((claim) => !claim.duplicateOf),
    digest: (maxClaims) => renderLedgerDigest(claims, maxClaims),
  };
}
