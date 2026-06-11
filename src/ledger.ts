import { generateObject } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { z } from "zod";
import { createConcurrencyGate } from "./async.js";
import { errorMessage } from "./errors.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import { QUARANTINE_NOTE, quarantine } from "./safety.js";
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
  | "quoted"
  | "confirmed"
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
}

export const EXTRACTION_INPUT_CHARS = 40_000;
const EXTRACTION_MAX_TOKENS = 2_000;
const EXTRACTION_CONCURRENCY = 8;
const MIN_EXTRACTABLE_CHARS = 200;
const LEDGER_DIGEST_MAX_CLAIMS = 60;
const NON_EVIDENCE_WARNINGS =
  /\b(?:blocked_or_challenge|thin_content|error_page|search_listing_page)\b/i;

const IMPORTANCE_VALUES = ["central", "supporting", "tangential"] as const;
const QUALITY_VALUES = [
  "primary",
  "secondary",
  "blog",
  "forum",
  "unreliable",
] as const;

const extractionSchema = z.object({
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
    .max(5),
});

const EXTRACTION_SYSTEM_PROMPT =
  "You extract falsifiable, verbatim-quoted claims from one fetched source document for a research run. " +
  QUARANTINE_NOTE;

function extractionPrompt(goal: string, document: SourceDocument): string {
  const text = document.markdown.slice(0, EXTRACTION_INPUT_CHARS);
  const truncationNote =
    document.markdown.length > EXTRACTION_INPUT_CHARS
      ? `\n(Source text truncated at ${EXTRACTION_INPUT_CHARS} of ${document.markdown.length} characters.)`
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
    '1. Assess source quality: primary research/official/institutional data → "primary"; reputable secondary reporting → "secondary"; personal blog or opinion → "blog"; forum or user-generated content → "forum"; spam, ads, paywalled stubs, or irrelevant pages → "unreliable".\n' +
    "2. Extract 2-5 falsifiable claims that bear on the research goal. Each claim must:\n" +
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
    const statusTag = claim.status === "quoted" ? "" : `·${claim.status}`;
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

export interface Ledger {
  readonly claims: ResearchClaim[];
  readonly unsupportedCount: number;
  readonly dupesDropped: number;
  queue(document: SourceDocument, opts: LedgerQueueOptions): void;
  settle(): Promise<void>;
  flush(agentId?: string): Promise<void>;
  byId(claimId: string): ResearchClaim | undefined;
  representatives(): ResearchClaim[];
  digest(maxClaims?: number): string;
}

export interface LedgerContext {
  emit(event: ResearchEvent): void;
  signal?: AbortSignal | undefined;
  shouldExtract(): boolean;
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
  let nextClaimNumber = 1;
  let unsupportedCount = 0;
  let dupesDropped = 0;

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
    const sameSource =
      representative.sourceId === claim.sourceId ||
      registrableHost(representative.url) === registrableHost(claim.url);
    if (sameSource) {
      dupesDropped++;
      return null;
    }
    const corroborating = new Set(representative.corroboratingSources ?? []);
    corroborating.add(claim.url);
    representative.corroboratingSources = [...corroborating];
    representative.corroboration = corroborating.size + 1;
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
    const result = await generateObject({
      model: opts.model,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionPrompt(opts.goal, document),
      schema: extractionSchema,
      maxOutputTokens: EXTRACTION_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: ctx.signal,
    });
    const extraction = result.object;
    const publishedTime =
      document.metadata.publishedTime ?? extraction.publishDate ?? undefined;
    const normalizedSource = normalizeForQuoteMatch(document.markdown);

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
        status: "quoted",
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

  function queue(document: SourceDocument, opts: LedgerQueueOptions): void {
    if (queuedSourceIds.has(document.sourceId)) return;
    queuedSourceIds.add(document.sourceId);
    if (!isEvidenceSource(document)) return;
    if (!ctx.shouldExtract()) return;

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

  return {
    claims,
    get unsupportedCount() {
      return unsupportedCount;
    },
    get dupesDropped() {
      return dupesDropped;
    },
    queue,
    settle,
    flush,
    byId: (claimId) => claimsById.get(claimId),
    representatives: () => claims.filter((claim) => !claim.duplicateOf),
    digest: (maxClaims) => renderLedgerDigest(claims, maxClaims),
  };
}
