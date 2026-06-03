import type { ModelStepInput, ModelStepResult } from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import type { ResearchClaim } from "./claims.js";
import { voteSplit } from "./verify.js";

const SYNTHESIS_MAX_TOKENS = 8_192;

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

export function renderConfirmedClaims(confirmed: ResearchClaim[]): string {
  return confirmed
    .map((claim, index) => {
      const supporting = claim.votes
        .filter((vote) => !vote.refuted)
        .sort(
          (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
        )[0];
      return (
        `### [${index}] ${claim.text}\n` +
        `Vote: ${voteSplit(claim)} · Source: ${claim.url} (${claim.sourceQuality}` +
        `${claim.publishedTime ? `, published ${claim.publishedTime}` : ""})\n` +
        `Quote: "${claim.quote}"\n` +
        (supporting
          ? `Verifier evidence (${supporting.confidence}): ${supporting.evidence}\n`
          : "")
      );
    })
    .join("\n");
}

export function renderRefutedClaims(refuted: ResearchClaim[]): string {
  if (refuted.length === 0) return "";
  return (
    "\n## Refuted claims (do NOT use these in the report except to note they were ruled out)\n" +
    refuted
      .map(
        (claim) =>
          `- "${claim.text}" (${claim.url}, vote ${voteSplit(claim)})`,
      )
      .join("\n")
  );
}

const SYNTHESIS_SYSTEM_PROMPT =
  "You write the final cited research report from adversarially verified claims. " +
  "Every factual statement must be traceable to a confirmed claim below, cited inline with the source URL as a Markdown link. " +
  "Never cite a source that is not attached to a confirmed claim, and never resurrect a refuted claim.";

export function synthesisPrompt(opts: {
  question: string;
  confirmed: ResearchClaim[];
  refuted: ResearchClaim[];
  gapsNote?: string;
}): string {
  return (
    "## Synthesis: research report\n\n" +
    `**Question:** ${opts.question}\n\n` +
    `${opts.confirmed.length} claims survived adversarial verification. Merge semantic duplicates and synthesize.\n\n` +
    "## Confirmed claims\n" +
    renderConfirmedClaims(opts.confirmed) +
    renderRefutedClaims(opts.refuted) +
    (opts.gapsNote ? `\n## Known gaps\n${opts.gapsNote}\n` : "") +
    "\n## Instructions\n" +
    "1. Merge claims that say the same thing; combine their sources.\n" +
    "2. Group related claims into coherent findings that directly address the research question.\n" +
    "3. Weight findings by confidence: unanimous votes on primary sources are strong; split votes or blog-quality sources are weak — say so.\n" +
    "4. Open with a short executive summary that answers the research question.\n" +
    "5. Note caveats: what is uncertain, which sources were weak, what is time-sensitive.\n" +
    "6. Close with open questions that emerged but were not answered.\n" +
    "7. Cite every claim inline with its source URL as a Markdown link. Cite only the URLs listed above.\n\n" +
    "Write the report as Markdown."
  );
}

export async function synthesizeReport(
  ctx: ResearchCtx,
  opts: {
    question: string;
    confirmed: ResearchClaim[];
    refuted: ResearchClaim[];
    gapsNote?: string;
  },
): Promise<string> {
  const input: ModelStepInput = {
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: synthesisPrompt(opts),
      },
    ],
    maxTokens: ctx.config.maxOutputTokens ?? SYNTHESIS_MAX_TOKENS,
    providerOptions: ctx.config.finalizeProviderOptions,
    signal: ctx.deps.signal,
  };
  const stepStream = ctx.deps.model.stepStream?.bind(ctx.deps.model);
  let result: ModelStepResult;
  if (stepStream) {
    result = await stepStream(input, {
      onStart: () => ctx.scope.emit({ type: "report_boundary" }),
      onText: (text) => ctx.scope.emit({ type: "report_delta", text }),
    });
  } else {
    result = await ctx.deps.model.step(input);
  }
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}
