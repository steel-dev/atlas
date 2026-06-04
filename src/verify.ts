import type {
  ModelAssistantBlock,
  ModelMessage,
  ModelOutputSchema,
  ModelToolCall,
  ModelToolDefinition,
  ModelToolResult,
} from "./model.js";
import {
  createConcurrencyGate,
  timeoutSynthesisReason,
  tokenBudgetExhaustedReason,
  type ConcurrencyGate,
  type ResearchCtx,
} from "./runtime.js";
import type { ClaimVote, ResearchClaim } from "./claims.js";
import { clusterClaims, CLUSTER_WINDOW } from "./cluster.js";
import { execSearch } from "./search-tool.js";
import { execReadSource, execSearchSources } from "./evidence-tool.js";
import { execRunCode } from "./code-tool.js";
import { errorMessage } from "./errors.js";

export const REFUTATIONS_REQUIRED = 2;
export const MAX_VERIFY_CLAIMS = 120;
const VERIFY_BATCH_SIZE = 16;
const DEFAULT_VERIFY_TARGET = 25;
const MAX_VOTER_TOOL_TURNS = 2;
const VOTER_STEP_MAX_TOKENS = 1_200;
const VERDICT_MAX_TOKENS = 600;
const VERIFY_CONCURRENCY = 8;

export type VerifierLens = "quote-fidelity" | "contradiction" | "source-strength";

interface VerifierSeat {
  lens: VerifierLens;
  focus?: string;
}

const VERIFIER_PANEL: readonly VerifierSeat[] = [
  { lens: "quote-fidelity" },
  {
    lens: "contradiction",
    focus:
      "Bias your queries toward more recent figures, corrections, retractions, or disputes that postdate the claim.",
  },
  {
    lens: "contradiction",
    focus:
      "Bias your queries toward primary sources or authorities that assert a different value, outcome, or conclusion.",
  },
  { lens: "source-strength" },
];

export const VOTES_PER_CLAIM = VERIFIER_PANEL.length;

export type VerifierPanelMode = "lens" | "clone";

const CLONE_PANEL: readonly VerifierSeat[] = Array.from(
  { length: VERIFIER_PANEL.length },
  (): VerifierSeat => ({ lens: "contradiction" }),
);

function panelFor(mode: VerifierPanelMode | undefined): readonly VerifierSeat[] {
  return mode === "clone" ? CLONE_PANEL : VERIFIER_PANEL;
}

export interface VerifySummary {
  verified: number;
  confirmed: number;
  refuted: number;
  unverified: number;
  beyondCap: number;
  clustersFormed: number;
  claimsDeduped: number;
}

const VERDICT_OUTPUT_SCHEMA: ModelOutputSchema = {
  name: "claim_verdict",
  schema: {
    type: "object",
    required: ["refuted", "evidence", "confidence"],
    properties: {
      refuted: { type: "boolean" },
      evidence: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
  },
};

const IMPORTANCE_RANK = { central: 0, supporting: 1, tangential: 2 } as const;
const QUALITY_RANK = {
  primary: 0,
  secondary: 1,
  blog: 2,
  forum: 3,
  unreliable: 4,
} as const;

export function rankClaimsForVerification(
  claims: ResearchClaim[],
): ResearchClaim[] {
  return claims
    .filter((claim) => claim.status === "quoted")
    .sort(
      (a, b) =>
        IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] ||
        QUALITY_RANK[a.sourceQuality] - QUALITY_RANK[b.sourceQuality],
    );
}

const SEARCH_TOOL: ModelToolDefinition = {
  name: "search",
  description:
    "Search the web for evidence about the claim. `queries` runs 1-2 query variants in parallel and returns one ranked result list with snippets.",
  input_schema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string" },
      },
    },
    required: ["queries"],
  },
};

const READ_SOURCE_TOOL: ModelToolDefinition = {
  name: "read_source",
  description:
    "Read exact text from the stored source document. Pass `chunk_index` to read a chunk, or `start`/`end` for an exact character span.",
  input_schema: {
    type: "object",
    properties: {
      source_id: { type: "string" },
      chunk_index: { type: "integer", minimum: 0 },
      start: { type: "integer", minimum: 0 },
      end: { type: "integer", minimum: 0 },
    },
    required: ["source_id"],
  },
};

const SEARCH_SOURCES_TOOL: ModelToolDefinition = {
  name: "search_sources",
  description:
    "Keyword-search the stored source documents and return matching snippets with source_id, chunk_index, and character spans for read_source.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      source_ids: { type: "array", items: { type: "string" } },
      max_results: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
  },
};

const RUN_CODE_TOOL: ModelToolDefinition = {
  name: "run_code",
  description:
    "Run synchronous JavaScript over stored source text to check exact values. In scope: `sources`, `grep(pattern, {source_ids?, ignore_case?, context?, max?})`, `print`. The final expression is returned.",
  input_schema: {
    type: "object",
    properties: {
      code: { type: "string" },
      source_ids: { type: "array", items: { type: "string" } },
    },
    required: ["code"],
  },
};

const LENS_TOOLS: Record<VerifierLens, ModelToolDefinition[]> = {
  "quote-fidelity": [READ_SOURCE_TOOL, SEARCH_SOURCES_TOOL, RUN_CODE_TOOL],
  contradiction: [SEARCH_TOOL],
  "source-strength": [READ_SOURCE_TOOL, SEARCH_SOURCES_TOOL],
};

const LENS_INSTRUCTIONS: Record<VerifierLens, string> = {
  "quote-fidelity":
    "Does the quote, in its surrounding context, actually support the claim — or is it an overreach, misread, or out-of-context fragment? " +
    "Use search_sources to locate the quote span, read_source to read the text around it, and run_code to check exact values. " +
    "refuted=true if the claim overstates, misreads, or cherry-picks the quote. refuted=false ONLY if the full context supports the claim as stated.",
  contradiction:
    "Search the web for evidence that contradicts or heavily qualifies this claim. " +
    "Run 1-2 targeted queries: counterclaims, more recent figures, disputes, corrections. " +
    "refuted=true if any credible result contradicts or heavily qualifies the claim, or shows it is outdated. refuted=false ONLY if you find no credible contradiction.",
  "source-strength":
    "Judge how strong this source is for the claim and whether the claim is current, then express that as confidence — not as a refutation. " +
    "Primary sources and corroboration are strong; marketing copy, press releases, cherry-picked benchmarks, blogs, and forum speculation are weak; stale claims about fast-moving topics are suspect. " +
    "Use read_source around the quote to judge the page's nature and date. " +
    "refuted=true ONLY if the source is not real evidence at all — spam, ads, fabrication, or a page that does not actually concern the claim. " +
    "For a merely weak, thin, or stale source, set refuted=false with confidence=low: weakness lowers confidence, it does not kill the claim.",
};

const VERIFIER_SYSTEM_PROMPT =
  `You are one adversarial verifier on a ${VOTES_PER_CLAIM}-voter panel judging one claim from a research run. ` +
  `Be SKEPTICAL: probe the claim through your assigned lens. ${REFUTATIONS_REQUIRED} of ${VOTES_PER_CLAIM} refutations kill the claim. ` +
  "Refute only when you find a concrete, nameable problem — a misquote, a credible contradiction, or a source that is not real evidence. " +
  "Uncertainty alone, or a merely weak source, is not grounds to refute; reflect that through low confidence instead. " +
  "Evidence must be specific — quote or cite what you checked.";

function voterPrompt(
  question: string,
  claim: ResearchClaim,
  seat: VerifierSeat,
): string {
  return (
    "## Claim under review\n" +
    `"${claim.text}"\n\n` +
    `Source: ${claim.url} (${claim.sourceQuality}, published ${claim.publishedTime ?? "unknown"}) · source_id ${claim.sourceId}\n` +
    `Supporting quote (mechanically verified to appear verbatim in the stored source text):\n"${claim.quote}"\n\n` +
    `Research question: "${question}"\n\n` +
    `## Your lens: ${seat.lens}\n` +
    LENS_INSTRUCTIONS[seat.lens] +
    (seat.focus ? "\n" + seat.focus : "") +
    "\n\n" +
    `You may use at most ${MAX_VOTER_TOOL_TURNS} tool turns before returning your verdict. Structured output only.`
  );
}

async function executeVoterTool(
  ctx: ResearchCtx,
  call: ModelToolCall,
  searchIndexRef: { next: number },
): Promise<ModelToolResult> {
  try {
    let content: string;
    if (call.name === "search") {
      const index = searchIndexRef.next;
      const input = (call.input ?? {}) as { queries?: string[] };
      searchIndexRef.next += Array.isArray(input.queries)
        ? input.queries.length
        : 1;
      content = await execSearch(input, ctx, index);
    } else if (call.name === "read_source") {
      content = execReadSource(call.input ?? {}, ctx);
    } else if (call.name === "search_sources") {
      content = execSearchSources(call.input ?? {}, ctx);
    } else if (call.name === "run_code") {
      content = execRunCode((call.input ?? {}) as { code?: string }, ctx);
    } else {
      return {
        type: "tool_result",
        tool_call_id: call.id,
        content: `Unknown tool: ${call.name}. Return your verdict.`,
        is_error: true,
      };
    }
    return { type: "tool_result", tool_call_id: call.id, content };
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return {
      type: "tool_result",
      tool_call_id: call.id,
      content: `Tool error: ${errorMessage(err)}`,
      is_error: true,
    };
  }
}

interface RawVerdict {
  refuted?: unknown;
  evidence?: unknown;
  confidence?: unknown;
}

function parseVerdict(content: ModelAssistantBlock[]): ClaimVote | null {
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  if (!textBlock) return null;
  try {
    const raw = JSON.parse(textBlock.text) as RawVerdict;
    if (typeof raw.refuted !== "boolean") return null;
    return {
      lens: "",
      refuted: raw.refuted,
      evidence: typeof raw.evidence === "string" ? raw.evidence : "",
      confidence:
        raw.confidence === "high" || raw.confidence === "medium"
          ? raw.confidence
          : "low",
    };
  } catch {
    return null;
  }
}

async function castVote(
  ctx: ResearchCtx,
  question: string,
  claim: ResearchClaim,
  seat: VerifierSeat,
  searchIndexRef: { next: number },
): Promise<ClaimVote | null> {
  const model = ctx.deps.leafModel ?? ctx.deps.model;
  const tools = LENS_TOOLS[seat.lens];
  const messages: ModelMessage[] = [
    { role: "user", content: voterPrompt(question, claim, seat) },
  ];

  for (let turn = 0; turn < MAX_VOTER_TOOL_TURNS; turn++) {
    if (tokenBudgetExhaustedReason(ctx) || timeoutSynthesisReason(ctx)) {
      return null;
    }
    const result = await model.step({
      system: VERIFIER_SYSTEM_PROMPT,
      tools,
      messages,
      maxTokens: VOTER_STEP_MAX_TOKENS,
      signal: ctx.deps.signal,
    });
    const toolCalls = result.content.filter(
      (block): block is ModelToolCall => block.type === "tool_call",
    );
    if (toolCalls.length === 0) break;
    messages.push({ role: "assistant", content: result.content });
    const toolResults = await Promise.all(
      toolCalls.map((call) => executeVoterTool(ctx, call, searchIndexRef)),
    );
    messages.push({ role: "user", content: toolResults });
  }

  if (tokenBudgetExhaustedReason(ctx) || timeoutSynthesisReason(ctx)) {
    return null;
  }
  messages.push({
    role: "user",
    content:
      "Return your verdict now as structured output: refuted, evidence, confidence.",
  });
  const verdictResult = await model.step({
    system: VERIFIER_SYSTEM_PROMPT,
    messages,
    maxTokens: VERDICT_MAX_TOKENS,
    outputSchema: VERDICT_OUTPUT_SCHEMA,
    signal: ctx.deps.signal,
  });
  const vote = parseVerdict(verdictResult.content);
  return vote ? { ...vote, lens: seat.lens } : null;
}

function settleClaim(claim: ResearchClaim, votes: ClaimVote[]): void {
  claim.votes = votes;
  const refutedVotes = votes.filter((vote) => vote.refuted).length;
  const contradictionVotes = votes.filter(
    (vote) => vote.lens === "contradiction",
  ).length;
  if (votes.length < REFUTATIONS_REQUIRED) {
    claim.status = "unverified";
  } else if (refutedVotes >= REFUTATIONS_REQUIRED) {
    claim.status = "refuted";
  } else if (contradictionVotes === 0) {
    claim.status = "unverified";
  } else {
    claim.status = "confirmed";
  }
}

export function voteSplit(claim: ResearchClaim): string {
  const refuted = claim.votes.filter((vote) => vote.refuted).length;
  return `${claim.votes.length - refuted}-${refuted}`;
}

async function verifyOneClaim(
  ctx: ResearchCtx,
  question: string,
  claim: ResearchClaim,
  gate: ConcurrencyGate,
  searchIndexRef: { next: number },
  panel: readonly VerifierSeat[],
): Promise<void> {
  const votes = (
    await Promise.all(
      panel.map((seat) =>
        gate
          .run(() => castVote(ctx, question, claim, seat, searchIndexRef))
          .catch((err: unknown) => {
            if (ctx.deps.signal?.aborted) throw err;
            return null;
          }),
      ),
    )
  ).filter((vote): vote is ClaimVote => vote !== null);
  settleClaim(claim, votes);
  ctx.scope.emit({
    type: "claim_verified",
    id: claim.id,
    claim: claim.text,
    vote: voteSplit(claim),
    status: claim.status,
  });
}

function propagateVerdictsToDuplicates(
  ctx: ResearchCtx,
  verifiedRepresentatives: ResearchClaim[],
): void {
  const settledById = new Map<string, ResearchClaim>();
  for (const representative of verifiedRepresentatives) {
    if (
      representative.status === "quoted" ||
      representative.status === "refuted"
    ) {
      continue;
    }
    settledById.set(representative.id, representative);
  }
  if (settledById.size === 0) return;
  for (const claim of ctx.store.claims.claims) {
    if (!claim.duplicateOf) continue;
    const representative = settledById.get(claim.duplicateOf);
    if (!representative) continue;
    claim.status = representative.status;
    claim.votes = representative.votes;
  }
}

export async function verifyClaims(
  ctx: ResearchCtx,
  question: string,
  searchIndexRef: { next: number } = { next: 0 },
): Promise<VerifySummary> {
  const ranked = rankClaimsForVerification(ctx.store.claims.claims);
  if (ranked.length === 0) {
    return {
      verified: 0,
      confirmed: 0,
      refuted: 0,
      unverified: 0,
      beyondCap: 0,
      clustersFormed: 0,
      claimsDeduped: 0,
    };
  }

  const cluster = await clusterClaims(ctx, ranked.slice(0, CLUSTER_WINDOW));
  const representatives = ranked.filter((claim) => !claim.duplicateOf);

  const target = Math.max(
    1,
    ctx.config.verifyTargetConfirmed ?? DEFAULT_VERIFY_TARGET,
  );
  const maxToVerify = Math.min(representatives.length, MAX_VERIFY_CLAIMS);

  ctx.scope.emit({ type: "verify_started", claims: maxToVerify });
  const gate = createConcurrencyGate(VERIFY_CONCURRENCY);
  const panel = panelFor(ctx.config.verifierPanel);

  let cursor = 0;
  let confirmed = 0;
  while (
    cursor < maxToVerify &&
    confirmed < target &&
    !tokenBudgetExhaustedReason(ctx) &&
    !timeoutSynthesisReason(ctx)
  ) {
    const wave = representatives.slice(
      cursor,
      Math.min(cursor + VERIFY_BATCH_SIZE, maxToVerify),
    );
    cursor += wave.length;
    await Promise.all(
      wave.map((claim) =>
        verifyOneClaim(ctx, question, claim, gate, searchIndexRef, panel),
      ),
    );
    confirmed += wave.filter((claim) => claim.status === "confirmed").length;
  }

  propagateVerdictsToDuplicates(ctx, representatives.slice(0, cursor));

  const verified = representatives.slice(0, cursor);
  const summary: VerifySummary = {
    verified: verified.length,
    confirmed: verified.filter((claim) => claim.status === "confirmed").length,
    refuted: verified.filter((claim) => claim.status === "refuted").length,
    unverified: verified.filter((claim) => claim.status === "unverified")
      .length,
    beyondCap: representatives.length - verified.length,
    clustersFormed: cluster.clustersFormed,
    claimsDeduped: cluster.claimsDeduped,
  };
  ctx.scope.emit({
    type: "verify_finished",
    confirmed: summary.confirmed,
    refuted: summary.refuted,
    unverified: summary.unverified,
  });
  return summary;
}
