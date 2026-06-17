import { generateObject, type FlexibleSchema } from "ai";
import { withTraceFrame } from "./trace.js";
import { z } from "zod";
import type { BudgetGrant } from "./budget.js";
import { MODEL_CALL_MAX_RETRIES } from "./model.js";
import type { RunCtx } from "./state.js";
import type { ResearchClaim } from "./ledger.js";

export interface BasisCitation {
  sourceId?: string;
  url: string;
  title: string;
  excerpt: string;
}

export interface FieldBasis {
  citations: BasisCitation[];
  reasoning: string;
}

export interface StructuredOutput<T = unknown> {
  data: T;
  basis: Record<string, FieldBasis>;
}

const DATA_MAX_TOKENS = 8_192;
const ATTRIBUTION_MAX_TOKENS = 8_192;
const MAX_BASIS_PATHS = 200;
const UNGROUNDED_REASONING =
  "No supporting claim in the verified ledger; this value is unverified.";

const DATA_SYSTEM_PROMPT =
  "You fill a structured output schema that answers one research question, using ONLY the numbered claims provided. " +
  "Prefer adversarially verified (confirmed) claims; you may use an unconfirmed candidate when no confirmed claim fits, but never invent a value that no claim supports. " +
  "If a field cannot be determined from the claims, use the schema's allowance (null, empty, or omit) instead of guessing.";

const ATTRIBUTION_SYSTEM_PROMPT =
  "You attribute each field of an already-produced structured output to the claims that support it. " +
  "For each field path you are given, list the indices of the numbered claims whose quote directly supports that field's value, plus one short sentence explaining how. " +
  "Use only the provided claim indices. If no claim supports a field, return an empty claims array for that path. Never invent claims or paths.";

const attributionSchema = z.object({
  fields: z.array(
    z.object({
      path: z.string(),
      claims: z.array(z.number().int()),
      reasoning: z.string(),
    }),
  ),
});

export function leafPaths(
  value: unknown,
  prefix = "",
  out: string[] = [],
): string[] {
  if (out.length >= MAX_BASIS_PATHS) return out;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (out.length >= MAX_BASIS_PATHS) break;
      leafPaths(value[i], prefix ? `${prefix}.${i}` : `${i}`, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= MAX_BASIS_PATHS) break;
      leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) {
    out.push(prefix);
  }
  return out;
}

function claimToCitation(claim: ResearchClaim): BasisCitation {
  return {
    sourceId: claim.sourceId,
    url: claim.url,
    title: claim.title,
    excerpt: claim.quote,
  };
}

function dedupeByUrl(citations: BasisCitation[]): BasisCitation[] {
  const seen = new Set<string>();
  const out: BasisCitation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push(citation);
  }
  return out;
}

function renderNumberedClaims(claims: ResearchClaim[]): string {
  if (claims.length === 0) return "(none)\n";
  return claims
    .map(
      (claim, index) =>
        `[${index}] ${claim.text}\n` +
        `    source: ${claim.url} (${claim.sourceQuality}) — "${claim.quote}"\n`,
    )
    .join("");
}

export async function synthesizeStructured<T>(
  rctx: RunCtx,
  grant: BudgetGrant,
  opts: {
    schema: FlexibleSchema<T>;
    confirmed: ResearchClaim[];
    candidates: ResearchClaim[];
  },
): Promise<StructuredOutput<T>> {
  const model = rctx.bindModel("write", grant);
  const dataResult = await withTraceFrame(rctx.recorder, { site: "structured" }, () =>
    generateObject({
    model,
    system: DATA_SYSTEM_PROMPT,
    prompt:
      `**Question:** ${rctx.question}\n\n` +
      "## Supported claims (confirmed, screened, or contested — prefer earlier ones)\n" +
      renderNumberedClaims(opts.confirmed) +
      (opts.candidates.length > 0
        ? "\n## Unconfirmed candidate claims (quote-grounded, NOT verified — fallback only)\n" +
          renderNumberedClaims(opts.candidates)
        : "") +
      "\nFill the output schema to answer the question using only these claims.",
    schema: opts.schema,
    maxOutputTokens: DATA_MAX_TOKENS,
    maxRetries: MODEL_CALL_MAX_RETRIES,
    abortSignal: rctx.signal,
  }),
  );
  const data = dataResult.object;

  const paths = leafPaths(data);
  const basis: Record<string, FieldBasis> = {};
  for (const path of paths) {
    basis[path] = { citations: [], reasoning: UNGROUNDED_REASONING };
  }
  if (paths.length === 0) return { data, basis };

  const numbered = [...opts.confirmed, ...opts.candidates];
  try {
    const attribution = await withTraceFrame(rctx.recorder, { site: "structured" }, () =>
      generateObject({
      model: rctx.bindModel("verify", grant),
      system: ATTRIBUTION_SYSTEM_PROMPT,
      prompt:
        `**Question:** ${rctx.question}\n\n` +
        "## Produced output\n```json\n" +
        JSON.stringify(data, null, 2) +
        "\n```\n\n" +
        "## Numbered claims\n" +
        renderNumberedClaims(numbered) +
        "\n## Field paths to attribute\n" +
        paths.map((path) => `- ${path}`).join("\n") +
        "\n\nFor each field path, list the claim indices that support that field's value and one short reasoning sentence.",
      schema: attributionSchema,
      maxOutputTokens: ATTRIBUTION_MAX_TOKENS,
      maxRetries: MODEL_CALL_MAX_RETRIES,
      abortSignal: rctx.signal,
    }),
    );
    const pathSet = new Set(paths);
    for (const field of attribution.object.fields) {
      if (!pathSet.has(field.path)) continue;
      const citations = dedupeByUrl(
        field.claims
          .map((index) => numbered[index])
          .filter((claim): claim is ResearchClaim => Boolean(claim))
          .map(claimToCitation),
      );
      basis[field.path] = { citations, reasoning: field.reasoning };
    }
  } catch (err) {
    if (rctx.signal?.aborted) throw err;
  }

  return { data, basis };
}

export const __testing = { leafPaths };
