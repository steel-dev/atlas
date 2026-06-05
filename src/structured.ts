import { asSchema, type FlexibleSchema } from "ai";
import type { ModelOutputSchema, ModelStepResult } from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import type { ResearchClaim } from "./claims.js";
import { withRole } from "./recording.js";

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

export interface StructuredOutput<T> {
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
  "If a field cannot be determined from the claims, use the schema's allowance (null, empty, or omit) instead of guessing. " +
  "Structured output only.";

const ATTRIBUTION_SYSTEM_PROMPT =
  "You attribute each field of an already-produced structured output to the claims that support it. " +
  "For each field path you are given, list the indices of the numbered claims whose quote directly supports that field's value, plus one short sentence explaining how. " +
  "Use only the provided claim indices. If no claim supports a field, return an empty claims array for that path. Never invent claims or paths. " +
  "Structured output only.";

const ATTRIBUTION_SCHEMA: ModelOutputSchema = {
  name: "field_basis",
  schema: {
    type: "object",
    required: ["fields"],
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "claims", "reasoning"],
          properties: {
            path: { type: "string" },
            claims: { type: "array", items: { type: "number" } },
            reasoning: { type: "string" },
          },
        },
      },
    },
  },
};

export function leafPaths(value: unknown, prefix = "", out: string[] = []): string[] {
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

interface AttributionField {
  path: string;
  claims: number[];
  reasoning: string;
}

export function parseAttribution(text: string): AttributionField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const fields = (parsed as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  const out: AttributionField[] = [];
  for (const entry of fields) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as { path?: unknown; claims?: unknown; reasoning?: unknown };
    if (typeof raw.path !== "string") continue;
    const claims = Array.isArray(raw.claims)
      ? raw.claims.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n),
        )
      : [];
    out.push({
      path: raw.path,
      claims,
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    });
  }
  return out;
}

function extractText(result: ModelStepResult): string {
  const block = result.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  return block?.text ?? "";
}

function parseData<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("structured output: model returned no data");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      "structured output: model returned invalid JSON for the schema",
    );
  }
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

function dataPrompt(
  question: string,
  confirmed: ResearchClaim[],
  candidates: ResearchClaim[],
): string {
  return (
    `**Question:** ${question}\n\n` +
    "## Confirmed claims (adversarially verified)\n" +
    renderNumberedClaims(confirmed) +
    (candidates.length > 0
      ? "\n## Unconfirmed candidate claims (quote-grounded, NOT verified — fallback only)\n" +
        renderNumberedClaims(candidates)
      : "") +
    "\nFill the output schema to answer the question using only these claims."
  );
}

function attributionPrompt(
  question: string,
  data: unknown,
  claims: ResearchClaim[],
  paths: string[],
): string {
  return (
    `**Question:** ${question}\n\n` +
    "## Produced output\n```json\n" +
    JSON.stringify(data, null, 2) +
    "\n```\n\n" +
    "## Numbered claims\n" +
    renderNumberedClaims(claims) +
    "\n## Field paths to attribute\n" +
    paths.map((path) => `- ${path}`).join("\n") +
    "\n\nFor each field path, list the claim indices that support that field's value and one short reasoning sentence."
  );
}

export async function synthesizeStructured<T>(
  ctx: ResearchCtx,
  opts: {
    question: string;
    schema: FlexibleSchema<T>;
    confirmed: ResearchClaim[];
    candidates: ResearchClaim[];
  },
): Promise<StructuredOutput<T>> {
  const jsonSchemaObject = await Promise.resolve(asSchema(opts.schema).jsonSchema);
  const dataResult = await withRole("structured.data", () =>
    ctx.deps.model.step({
      system: DATA_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: dataPrompt(opts.question, opts.confirmed, opts.candidates),
        },
      ],
      maxTokens: DATA_MAX_TOKENS,
      outputSchema: {
        name: "structured_output",
        schema: jsonSchemaObject as Record<string, unknown>,
      },
      providerOptions: ctx.config.finalizeProviderOptions,
      signal: ctx.deps.signal,
    }),
  );
  const data = parseData<T>(extractText(dataResult));

  const paths = leafPaths(data);
  const basis: Record<string, FieldBasis> = {};
  for (const path of paths) {
    basis[path] = { citations: [], reasoning: UNGROUNDED_REASONING };
  }
  if (paths.length === 0) return { data, basis };

  const numbered = [...opts.confirmed, ...opts.candidates];
  try {
    const attributionResult = await withRole("structured.basis", () =>
      ctx.deps.model.step({
        system: ATTRIBUTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: attributionPrompt(opts.question, data, numbered, paths),
          },
        ],
        maxTokens: ATTRIBUTION_MAX_TOKENS,
        outputSchema: ATTRIBUTION_SCHEMA,
        providerOptions: ctx.config.finalizeProviderOptions,
        signal: ctx.deps.signal,
      }),
    );
    const pathSet = new Set(paths);
    for (const field of parseAttribution(extractText(attributionResult))) {
      if (!pathSet.has(field.path)) continue;
      const citations = dedupeByUrl(
        field.claims
          .map((index) => numbered[index])
          .filter((claim): claim is ResearchClaim => Boolean(claim))
          .map(claimToCitation),
      );
      basis[field.path] = { citations, reasoning: field.reasoning };
    }
  } catch {
    // basis is best-effort: keep the pre-seeded ungrounded entries on failure
  }

  return { data, basis };
}

export const __testing = { leafPaths, parseAttribution };
