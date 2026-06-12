export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  model?: string | null;
}

export interface CostBreakdown {
  model: string | null;
  priced: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  usd: number | null;
}

function priceFor(model: string | null | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const bare = model.includes(".")
    ? model.split(".").slice(1).join(".")
    : model;
  return PRICES[model] ?? PRICES[bare];
}

export function costOf(usage: TokenUsage): CostBreakdown {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const price = priceFor(usage.model);
  const usd = price
    ? (input * price.input +
        cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
        cacheRead * price.input * CACHE_READ_MULTIPLIER +
        output * price.output) /
      1_000_000
    : null;
  return {
    model: usage.model ?? null,
    priced: price !== undefined,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    usd: usd === null ? null : Number(usd.toFixed(4)),
  };
}

export interface RunUsage {
  research?: TokenUsage | null;
  leaf?: TokenUsage | null;
  judge?: (TokenUsage & { calls?: number; gradeRuns?: number }) | null;
}

export interface RunCost {
  research: CostBreakdown | null;
  leaf: CostBreakdown | null;
  judge: CostBreakdown | null;
  totalUsd: number | null;
}

export function runCost(usage: RunUsage | null | undefined): RunCost {
  const research = usage?.research ? costOf(usage.research) : null;
  const leaf = usage?.leaf ? costOf(usage.leaf) : null;
  const judge = usage?.judge ? costOf(usage.judge) : null;
  const parts = [research?.usd, leaf?.usd, judge?.usd].filter(
    (v): v is number => typeof v === "number",
  );
  const totalUsd =
    parts.length > 0
      ? Number(parts.reduce((s, v) => s + v, 0).toFixed(4))
      : null;
  return { research, leaf, judge, totalUsd };
}
