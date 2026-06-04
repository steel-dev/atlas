import type { ModelOutputSchema } from "./model.js";
import { tokenBudgetExhaustedReason, type ResearchCtx } from "./runtime.js";
import type { ResearchClaim } from "./claims.js";

export const CLUSTER_WINDOW = 150;
const CLUSTER_MAX_TOKENS = 2_000;
const MIN_CLUSTERABLE = 2;

export interface ClusterOutcome {
  clustersFormed: number;
  claimsDeduped: number;
}

const CLUSTER_OUTPUT_SCHEMA: ModelOutputSchema = {
  name: "claim_clusters",
  schema: {
    type: "object",
    required: ["clusters"],
    properties: {
      clusters: {
        type: "array",
        items: {
          type: "object",
          required: ["claimIds"],
          properties: {
            claimIds: {
              type: "array",
              minItems: 2,
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const CLUSTER_SYSTEM_PROMPT =
  "You group research claims that assert the same underlying fact so each fact is verified once, not once per source. Structured output only.";

function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function clusterPrompt(claims: ResearchClaim[]): string {
  const lines = claims.map(
    (claim) =>
      `[${claim.id}] ${claim.text} — ${shortHost(claim.url)} (${claim.sourceQuality})`,
  );
  return (
    "## Candidate claims\n" +
    lines.join("\n") +
    "\n\n## Task\n" +
    "Group claims that assert the SAME underlying fact — the same quantity, event, or relationship — even when worded differently (paraphrase, the same value rounded differently, the same measure in different units). " +
    "Do NOT group claims that merely share a topic but assert different facts; when unsure, keep them separate. " +
    "Return one entry per group of 2 or more equivalent claims, listing their ids. Omit singletons.\n\nStructured output only."
  );
}

interface RawClusters {
  clusters?: unknown;
}

function parseClusters(text: string): string[][] {
  let raw: RawClusters = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      raw = parsed as RawClusters;
    }
  } catch {
    return [];
  }
  if (!Array.isArray(raw.clusters)) return [];
  const groups: string[][] = [];
  for (const entry of raw.clusters) {
    const ids = (entry as { claimIds?: unknown }).claimIds;
    if (!Array.isArray(ids)) continue;
    const cleaned = ids
      .map((id) => String(id ?? "").trim())
      .filter((id) => id.length > 0);
    if (cleaned.length >= MIN_CLUSTERABLE) groups.push(cleaned);
  }
  return groups;
}

export async function clusterClaims(
  ctx: ResearchCtx,
  claims: ResearchClaim[],
): Promise<ClusterOutcome> {
  const empty: ClusterOutcome = { clustersFormed: 0, claimsDeduped: 0 };
  if (claims.length < MIN_CLUSTERABLE) return empty;
  if (tokenBudgetExhaustedReason(ctx)) return empty;

  const byId = new Map(claims.map((claim) => [claim.id, claim] as const));
  const rankOf = new Map(
    claims.map((claim, index) => [claim.id, index] as const),
  );

  let groups: string[][];
  try {
    const model = ctx.deps.leafModel ?? ctx.deps.model;
    const result = await model.step({
      system: CLUSTER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: clusterPrompt(claims) }],
      maxTokens: CLUSTER_MAX_TOKENS,
      outputSchema: CLUSTER_OUTPUT_SCHEMA,
      signal: ctx.deps.signal,
    });
    const textBlock = result.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    groups = parseClusters(textBlock?.text ?? "{}");
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return empty;
  }

  const assigned = new Set<string>();
  let clustersFormed = 0;
  let claimsDeduped = 0;
  for (const group of groups) {
    const members: ResearchClaim[] = [];
    for (const id of group) {
      const claim = byId.get(id);
      if (claim && !assigned.has(id)) members.push(claim);
    }
    if (members.length < MIN_CLUSTERABLE) continue;
    members.sort((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0));
    for (const member of members) assigned.add(member.id);
    const [representative, ...rest] = members;
    representative.corroboration = new Set(
      members.map((member) => member.sourceId),
    ).size;
    representative.corroboratingSources = [
      ...new Set(members.map((member) => member.url)),
    ];
    for (const member of rest) member.duplicateOf = representative.id;
    clustersFormed++;
    claimsDeduped += rest.length;
  }

  if (clustersFormed > 0) {
    ctx.scope.emit({ type: "claims_clustered", clustersFormed, claimsDeduped });
  }
  return { clustersFormed, claimsDeduped };
}
