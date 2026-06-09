import { type ModelOutputSchema } from "./model.js";
import {
  createConcurrencyGate,
  researchBudgetExhaustedReason,
  type ResearchCtx,
} from "./runtime.js";
import type { SourceDocument } from "./sources.js";
import { withRole } from "./recording.js";
import { errorMessage } from "./errors.js";

export type ClaimImportance = "central" | "supporting" | "tangential";

export type ClaimSourceQuality =
  | "primary"
  | "secondary"
  | "blog"
  | "forum"
  | "unreliable";

export type ClaimStatus =
  | "quoted"
  | "unsupported"
  | "confirmed"
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
  duplicateOf?: string;
  corroboration?: number;
  corroboratingSources?: string[];
}

export interface ClaimLedger {
  readonly claims: ResearchClaim[];
  readonly unsupportedCount: number;
  queue(ctx: ResearchCtx, document: SourceDocument, goal?: string): void;
  settle(): Promise<void>;
}

export const EXTRACTION_INPUT_CHARS = 40_000;
const EXTRACTION_MAX_TOKENS = 2_000;
const EXTRACTION_CONCURRENCY = 8;
const MIN_EXTRACTABLE_CHARS = 200;
const NON_EVIDENCE_WARNINGS =
  /\b(?:blocked_or_challenge|thin_content|error_page|search_listing_page)\b/i;

const IMPORTANCE_VALUES: readonly ClaimImportance[] = [
  "central",
  "supporting",
  "tangential",
];

const QUALITY_VALUES: readonly ClaimSourceQuality[] = [
  "primary",
  "secondary",
  "blog",
  "forum",
  "unreliable",
];

const EXTRACTION_OUTPUT_SCHEMA: ModelOutputSchema = {
  name: "extracted_claims",
  schema: {
    type: "object",
    required: ["claims", "sourceQuality"],
    properties: {
      sourceQuality: { type: "string", enum: [...QUALITY_VALUES] },
      publishDate: { type: "string" },
      claims: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["claim", "quote", "importance"],
          properties: {
            claim: { type: "string" },
            quote: { type: "string" },
            importance: { type: "string", enum: [...IMPORTANCE_VALUES] },
          },
        },
      },
    },
  },
};

const EXTRACTION_SYSTEM_PROMPT =
  "You extract falsifiable, verbatim-quoted claims from one fetched source document for a research run. Structured output only.";

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
    'Source text:\n"""\n' +
    text +
    '\n"""' +
    truncationNote +
    "\n\n## Task\n" +
    '1. Assess source quality: primary research/official/institutional data → "primary"; reputable secondary reporting → "secondary"; personal blog or opinion → "blog"; forum or user-generated content → "forum"; spam, ads, paywalled stubs, or irrelevant pages → "unreliable".\n' +
    "2. Extract 2-5 falsifiable claims that bear on the research goal. Each claim must:\n" +
    "   - be a concrete, checkable statement that preserves exact values, dates, and named entities\n" +
    "   - include a supporting quote copied VERBATIM from the source text above — it is string-matched against the stored text, so never paraphrase, correct, reorder, or splice\n" +
    "   - be rated central, supporting, or tangential to the research goal\n" +
    "3. Record the publish date if the text states one.\n\n" +
    "If the source is irrelevant, empty, or low-value, return claims: [] with the appropriate sourceQuality.\n" +
    "Structured output only."
  );
}

export function normalizeForQuoteMatch(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
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

interface RawExtractedClaim {
  claim?: unknown;
  quote?: unknown;
  importance?: unknown;
}

interface RawExtraction {
  sourceQuality?: unknown;
  publishDate?: unknown;
  claims?: unknown;
}

function readImportance(raw: unknown): ClaimImportance {
  return IMPORTANCE_VALUES.find((value) => value === raw) ?? "tangential";
}

function readQuality(raw: unknown): ClaimSourceQuality {
  return QUALITY_VALUES.find((value) => value === raw) ?? "unreliable";
}

function parseExtraction(text: string): RawExtraction {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as RawExtraction)
      : {};
  } catch {
    return {};
  }
}

interface ExtractionOutcome {
  quoted: ResearchClaim[];
  unsupported: number;
}

async function extractClaims(
  ctx: ResearchCtx,
  document: SourceDocument,
  goal?: string,
): Promise<ExtractionOutcome> {
  const model = ctx.deps.leafModel ?? ctx.deps.model;
  const result = await withRole("extract", () =>
    model.step({
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: extractionPrompt(
            goal?.trim() || ctx.scope.query || "",
            document,
          ),
        },
      ],
      maxTokens: EXTRACTION_MAX_TOKENS,
      outputSchema: EXTRACTION_OUTPUT_SCHEMA,
      signal: ctx.deps.signal,
    }),
  );
  const textBlock = result.content.find(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  const extraction = parseExtraction(textBlock?.text ?? "{}");
  const sourceQuality = readQuality(extraction.sourceQuality);
  const publishedTime =
    document.metadata.publishedTime ??
    (typeof extraction.publishDate === "string" && extraction.publishDate
      ? extraction.publishDate
      : undefined);
  const rawClaims = Array.isArray(extraction.claims) ? extraction.claims : [];
  const normalizedSource = normalizeForQuoteMatch(document.markdown);

  const quoted: ResearchClaim[] = [];
  let unsupported = 0;
  for (const raw of rawClaims as RawExtractedClaim[]) {
    const text = typeof raw.claim === "string" ? raw.claim.trim() : "";
    const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
    if (!text) continue;
    const supported = quoteSupportedIn(normalizedSource, quote);
    if (!supported) {
      unsupported++;
      continue;
    }
    quoted.push({
      id: "",
      text,
      quote,
      importance: readImportance(raw.importance),
      sourceQuality,
      sourceId: document.sourceId,
      url: document.url,
      title: document.title,
      ...(publishedTime ? { publishedTime } : {}),
      status: "quoted",
      votes: [],
    });
  }
  return { quoted, unsupported };
}

function isEvidenceSource(document: SourceDocument): boolean {
  if (document.markdown.length < MIN_EXTRACTABLE_CHARS) return false;
  const warnings = document.metadata.qualityWarnings ?? [];
  return !warnings.some((warning) => NON_EVIDENCE_WARNINGS.test(warning));
}

export function createClaimLedger(): ClaimLedger {
  const claims: ResearchClaim[] = [];
  const queuedSourceIds = new Set<string>();
  const pending = new Set<Promise<void>>();
  const gate = createConcurrencyGate(EXTRACTION_CONCURRENCY);
  let nextClaimNumber = 1;
  let unsupportedCount = 0;

  function queue(ctx: ResearchCtx, document: SourceDocument, goal?: string): void {
    if (queuedSourceIds.has(document.sourceId)) return;
    queuedSourceIds.add(document.sourceId);
    if (!isEvidenceSource(document)) return;
    if (researchBudgetExhaustedReason(ctx)) return;

    const task = gate
      .run(() => extractClaims(ctx, document, goal))
      .then(({ quoted, unsupported }) => {
        for (const claim of quoted) {
          claim.id = `claim_${nextClaimNumber++}`;
          claims.push(claim);
        }
        unsupportedCount += unsupported;
        ctx.scope.emit({
          type: "claims_extracted",
          sourceId: document.sourceId,
          url: document.url,
          count: quoted.length,
          unsupported,
        });
      })
      .catch((err: unknown) => {
        if (ctx.deps.signal?.aborted) return;
        ctx.scope.emit({
          type: "claims_extracted",
          sourceId: document.sourceId,
          url: document.url,
          count: 0,
          unsupported: 0,
          error: errorMessage(err),
        });
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  async function settle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  }

  return {
    claims,
    get unsupportedCount() {
      return unsupportedCount;
    },
    queue,
    settle,
  };
}
