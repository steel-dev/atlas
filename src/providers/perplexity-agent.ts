import { withTimeout } from "../async.js";
import { readEnv } from "../env.js";
import type { Researcher } from "../researcher.js";

export interface PerplexityPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  citationPerMTok: number;
  reasoningPerMTok: number;
  perThousandSearches: number;
}

export interface PerplexityAgentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  description?: string;
  pricing?: Partial<PerplexityPricing>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_DESCRIPTION =
  "Perplexity Sonar deep-research: fast web-grounded research with inline citations. Strong on current events, quick fact-checks, and broad Q&A.";

const PERPLEXITY_RATES: Record<string, PerplexityPricing> = {
  "sonar-deep-research": {
    inputPerMTok: 2,
    outputPerMTok: 8,
    citationPerMTok: 2,
    reasoningPerMTok: 3,
    perThousandSearches: 5,
  },
  sonar: {
    inputPerMTok: 1,
    outputPerMTok: 1,
    citationPerMTok: 0,
    reasoningPerMTok: 0,
    perThousandSearches: 0,
  },
  "sonar-pro": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    citationPerMTok: 0,
    reasoningPerMTok: 0,
    perThousandSearches: 0,
  },
};
const FALLBACK_RATES = PERPLEXITY_RATES["sonar-deep-research"]!;

interface PerplexityUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  citation_tokens?: number;
  reasoning_tokens?: number;
  num_search_queries?: number;
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: Array<{ url?: string; title?: string }>;
  usage?: PerplexityUsage;
}

function perplexityCost(
  usage: PerplexityUsage | undefined,
  model: string,
  override: Partial<PerplexityPricing> | undefined,
): number | undefined {
  if (!usage) return undefined;
  const r = { ...(PERPLEXITY_RATES[model] ?? FALLBACK_RATES), ...override };
  return (
    ((usage.prompt_tokens ?? 0) * r.inputPerMTok +
      (usage.completion_tokens ?? 0) * r.outputPerMTok +
      (usage.citation_tokens ?? 0) * r.citationPerMTok +
      (usage.reasoning_tokens ?? 0) * r.reasoningPerMTok) /
      1_000_000 +
    ((usage.num_search_queries ?? 0) / 1000) * r.perThousandSearches
  );
}

export function perplexityAgent(opts: PerplexityAgentOptions = {}): Researcher {
  const apiKey =
    opts.apiKey ?? readEnv("ATLAS_PERPLEXITY_API_KEY", "PERPLEXITY_API_KEY");
  const endpoint = `${(opts.baseUrl ?? "https://api.perplexity.ai").replace(/\/+$/, "")}/chat/completions`;
  return {
    description: opts.description ?? DEFAULT_DESCRIPTION,
    async research(query, ctx) {
      if (!apiKey) {
        throw new Error(
          "perplexity.agent: no API key (set ATLAS_PERPLEXITY_API_KEY / PERPLEXITY_API_KEY or pass { apiKey })",
        );
      }
      const model = opts.model ?? "sonar-deep-research";
      const data = await withTimeout(
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ctx.signal,
        "perplexity.agent",
        async (signal) => {
          const resp = await fetch(endpoint, {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: query }],
            }),
          });
          if (!resp.ok) {
            throw new Error(`perplexity.agent: HTTP ${resp.status}`);
          }
          return (await resp.json()) as PerplexityResponse;
        },
      );
      if (!data.choices || data.choices.length === 0) {
        throw new Error(
          "perplexity.agent: response had no choices (HTTP 200 with an error body?)",
        );
      }
      const report = (data.choices[0]?.message?.content ?? "").trim();
      const fromResults = (data.search_results ?? [])
        .filter((r): r is { url: string; title?: string } => Boolean(r.url))
        .map((r) => ({ url: r.url, ...(r.title ? { title: r.title } : {}) }));
      const sources =
        fromResults.length > 0
          ? fromResults
          : (data.citations ?? []).map((url) => ({ url }));
      const cost = perplexityCost(data.usage, model, opts.pricing);
      ctx.log(
        `perplexity.agent: ${sources.length} sources` +
          (cost != null
            ? `, $${cost.toFixed(4)}`
            : " (cost unknown — no usage in response)"),
      );
      return { report, sources, ...(cost != null ? { cost } : {}) };
    },
  };
}
