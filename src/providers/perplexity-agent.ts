import { readEnv } from "../env.js";
import type { Researcher } from "../researcher.js";

export interface PerplexityAgentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  describe?: string;
}

const DEFAULT_DESCRIBE =
  "Perplexity Sonar deep-research: fast web-grounded research with inline citations. Strong on current events, quick fact-checks, and broad Q&A.";

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ url?: string; title?: string }>;
}

export function perplexityAgent(opts: PerplexityAgentOptions = {}): Researcher {
  const apiKey =
    opts.apiKey ?? readEnv("ATLAS_PERPLEXITY_API_KEY", "PERPLEXITY_API_KEY");
  const endpoint = `${(opts.baseUrl ?? "https://api.perplexity.ai").replace(/\/+$/, "")}/chat/completions`;
  return {
    describe: opts.describe ?? DEFAULT_DESCRIBE,
    async research(query, ctx) {
      if (!apiKey) {
        throw new Error(
          "perplexity.agent: no API key (set ATLAS_PERPLEXITY_API_KEY / PERPLEXITY_API_KEY or pass { apiKey })",
        );
      }
      const resp = await fetch(endpoint, {
        method: "POST",
        signal: ctx.signal ?? null,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model ?? "sonar-deep-research",
          messages: [{ role: "user", content: query }],
        }),
      });
      if (!resp.ok) {
        throw new Error(`perplexity.agent: HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as PerplexityResponse;
      const report = (data.choices?.[0]?.message?.content ?? "").trim();
      const fromResults = (data.search_results ?? [])
        .filter((r): r is { url: string; title?: string } => Boolean(r.url))
        .map((r) => ({ url: r.url, ...(r.title ? { title: r.title } : {}) }));
      const sources =
        fromResults.length > 0
          ? fromResults
          : (data.citations ?? []).map((url) => ({ url }));
      ctx.log(`perplexity.agent: ${sources.length} sources`);
      return { report, sources };
    },
  };
}
