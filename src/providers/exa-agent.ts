import { Exa } from "exa-js";
import { readEnv } from "../env.js";
import type { Researcher } from "../researcher.js";

export interface ExaAgentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: "exa-research-fast" | "exa-research" | "exa-research-pro";
  timeoutMs?: number;
  describe?: string;
}

const DEFAULT_DESCRIBE =
  "Exa's agentic deep-research (exa-research): autonomously searches, reads, and synthesizes a grounded report. Strong on shopping/product comparison, personalized and recency-heavy queries.";

const URL_RE = /https?:\/\/[^\s)<>\]]+/g;

function sourcesFromText(text: string): { url: string }[] {
  const seen = new Set<string>();
  const out: { url: string }[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ url });
    }
  }
  return out;
}

export function exaAgent(opts: ExaAgentOptions = {}): Researcher {
  const apiKey = opts.apiKey ?? readEnv("ATLAS_EXA_API_KEY", "EXA_API_KEY");
  return {
    describe: opts.describe ?? DEFAULT_DESCRIBE,
    async research(query, ctx) {
      if (!apiKey) {
        throw new Error(
          "exa.agent: no Exa API key (set ATLAS_EXA_API_KEY / EXA_API_KEY or pass { apiKey })",
        );
      }
      const client = new Exa(apiKey, opts.baseUrl);
      const created = (await client.research.create({
        instructions: query,
        model: opts.model ?? "exa-research",
      })) as { researchId: string };
      const result = await client.research.pollUntilFinished(created.researchId, {
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      if (result.status !== "completed") {
        throw new Error(`exa.agent: research ${result.status}`);
      }
      const fields = result as {
        output?: { content?: string };
        costDollars?: { total?: number };
      };
      const report = (fields.output?.content ?? "").trim();
      const sources = sourcesFromText(report);
      const cost = fields.costDollars?.total;
      ctx.log(`exa.agent: ${sources.length} sources${cost != null ? `, $${cost}` : ""}`);
      return { report, sources, ...(cost != null ? { cost } : {}) };
    },
  };
}
