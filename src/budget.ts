import { ECONOMY } from "./economy.js";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export type PricingTable = Record<string, ModelPricing>;

export const DEFAULT_PRICING: PricingTable = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "gpt-5.5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5.1": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  "gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "o4-mini-deep-research": { inputPerMTok: 2, outputPerMTok: 8 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-3-flash-preview": { inputPerMTok: 0.5, outputPerMTok: 3 },
  "gemini-3.1-flash-lite": { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9 },
  "GLM-5.2": {
    inputPerMTok: 1.4,
    cacheReadPerMTok: 0.26,
    cacheWritePerMTok: 0,
    outputPerMTok: 4.4,
  },
  "GLM-5.1": {
    inputPerMTok: 1.4,
    cacheReadPerMTok: 0.26,
    cacheWritePerMTok: 0,
    outputPerMTok: 4.4,
  },
  "GLM-5": {
    inputPerMTok: 1,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
    outputPerMTok: 3.2,
  },
  "GLM-5-Turbo": {
    inputPerMTok: 1.2,
    cacheReadPerMTok: 0.24,
    cacheWritePerMTok: 0,
    outputPerMTok: 4,
  },
  "GLM-4.7": {
    inputPerMTok: 0.6,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    outputPerMTok: 2.2,
  },
  "GLM-4.7-FlashX": {
    inputPerMTok: 0.07,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0,
    outputPerMTok: 0.4,
  },
  "GLM-4.6": {
    inputPerMTok: 0.6,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    outputPerMTok: 2.2,
  },
  "GLM-4.5": {
    inputPerMTok: 0.6,
    cacheReadPerMTok: 0.11,
    cacheWritePerMTok: 0,
    outputPerMTok: 2.2,
  },
  "GLM-4.5-X": {
    inputPerMTok: 2.2,
    cacheReadPerMTok: 0.45,
    cacheWritePerMTok: 0,
    outputPerMTok: 8.9,
  },
  "GLM-4.5-Air": {
    inputPerMTok: 0.2,
    cacheReadPerMTok: 0.03,
    cacheWritePerMTok: 0,
    outputPerMTok: 1.1,
  },
  "GLM-4.5-AirX": {
    inputPerMTok: 1.1,
    cacheReadPerMTok: 0.22,
    cacheWritePerMTok: 0,
    outputPerMTok: 4.5,
  },
  "GLM-4-32B-0414-128K": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.1,
  },
  "GLM-4.7-Flash": { inputPerMTok: 0, outputPerMTok: 0 },
  "GLM-4.5-Flash": { inputPerMTok: 0, outputPerMTok: 0 },
};
for (const pricing of Object.values(DEFAULT_PRICING)) {
  Object.freeze(pricing);
}
Object.freeze(DEFAULT_PRICING);

const UNKNOWN_MODEL_PRICING: ModelPricing = {
  inputPerMTok: 10,
  outputPerMTok: 50,
};

const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokenUsage(target: TokenUsage, delta: TokenUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
}

export function resolvePricing(
  modelId: string | undefined,
  table: PricingTable,
): { pricing: ModelPricing; known: boolean } {
  if (!modelId) return { pricing: UNKNOWN_MODEL_PRICING, known: false };
  const lookup = (candidate: string): ModelPricing | undefined => {
    const direct = table[candidate];
    if (direct) return direct;
    const caseInsensitiveKey = Object.keys(table).find(
      (key) => key.toLowerCase() === candidate.toLowerCase(),
    );
    return caseInsensitiveKey ? table[caseInsensitiveKey] : undefined;
  };
  const direct = lookup(modelId);
  if (direct) return { pricing: direct, known: true };
  const undated = modelId.replace(/-\d{8}$/, "");
  const undatedPricing = lookup(undated);
  if (undatedPricing) return { pricing: undatedPricing, known: true };
  const parts = undated.split(".");
  for (let i = 1; i < parts.length; i++) {
    const candidate = lookup(parts.slice(i).join("."));
    if (candidate) return { pricing: candidate, known: true };
  }
  for (const key of Object.keys(table)) {
    const haystack = undated.toLowerCase();
    const needle = key.toLowerCase();
    if (haystack.startsWith(`${needle}-`) || haystack.endsWith(`.${needle}`)) {
      return { pricing: table[key], known: true };
    }
  }
  return { pricing: UNKNOWN_MODEL_PRICING, known: false };
}

export function usageCostUSD(
  usage: TokenUsage,
  pricing: ModelPricing,
): number {
  const cacheRead =
    pricing.cacheReadPerMTok ?? pricing.inputPerMTok * CACHE_READ_FACTOR;
  const cacheWrite =
    pricing.cacheWritePerMTok ?? pricing.inputPerMTok * CACHE_WRITE_FACTOR;
  return (
    (usage.input * pricing.inputPerMTok +
      usage.output * pricing.outputPerMTok +
      usage.cacheRead * cacheRead +
      usage.cacheWrite * cacheWrite) /
    1_000_000
  );
}

const GRANT_FLOOR_USD = ECONOMY.grantFloorUSD;
const DEFAULT_GRANT_FRACTION = ECONOMY.defaultGrantFraction;
const METER_EXHAUSTION_EPSILON_USD = 0.01;

export interface GrantOptions {
  fraction?: number;
  maxUSD?: number;
  minUSD?: number;
}

export interface BudgetHold {
  settle(actualUSD: number): void;
  release(): void;
}

export interface BudgetGrant {
  readonly limitUSD: number;
  spentUSD(): number;
  remainingUSD(): number;
  floored(): boolean;
  charge(usd: number): void;
  reserve(usd: number): BudgetHold | null;
  grant(opts?: GrantOptions): BudgetGrant | null;
  release(): void;
}

export interface BudgetMeter extends BudgetGrant {
  readonly totalUSD: number;
  totalSpentUSD(): number;
  exhausted(): boolean;
}

interface SharedSpend {
  spent: number;
}

class GrantNode implements BudgetGrant {
  readonly limitUSD: number;
  protected used = 0;
  protected childReserved = 0;
  private held = 0;
  private active = true;

  constructor(
    limitUSD: number,
    protected readonly shared: SharedSpend,
    private readonly parent: GrantNode | null,
  ) {
    this.limitUSD = limitUSD;
  }

  spentUSD(): number {
    return this.used;
  }

  remainingUSD(): number {
    return Math.max(
      0,
      this.limitUSD - this.used - this.childReserved - this.held,
    );
  }

  floored(): boolean {
    return this.remainingUSD() < GRANT_FLOOR_USD;
  }

  charge(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.used += usd;
    this.shared.spent += usd;
  }

  reserve(usd: number): BudgetHold | null {
    if (!Number.isFinite(usd) || usd <= 0) return null;
    const amount = Math.min(usd, this.remainingUSD());
    if (amount <= 0) return null;
    this.held += amount;
    let open = true;
    const free = (): boolean => {
      if (!open) return false;
      open = false;
      this.held = Math.max(0, this.held - amount);
      return true;
    };
    return {
      settle: (actualUSD: number) => {
        if (free()) this.charge(actualUSD);
      },
      release: () => {
        free();
      },
    };
  }

  grant(opts: GrantOptions = {}): BudgetGrant | null {
    const remaining = this.remainingUSD();
    if (remaining < GRANT_FLOOR_USD) return null;
    const fraction = clampFraction(opts.fraction);
    let want = opts.maxUSD ?? remaining * fraction;
    want = Math.max(want, opts.minUSD ?? GRANT_FLOOR_USD);
    const amount = Math.min(want, remaining);
    if (amount < GRANT_FLOOR_USD) return null;
    this.childReserved += amount;
    return new GrantNode(amount, this.shared, this);
  }

  release(): void {
    if (!this.active || !this.parent) return;
    this.active = false;
    this.parent.absorbChild(this.limitUSD, this.used);
  }

  protected absorbChild(limit: number, used: number): void {
    this.childReserved = Math.max(0, this.childReserved - limit);
    this.used += used;
  }
}

class RootMeter extends GrantNode implements BudgetMeter {
  readonly totalUSD: number;

  constructor(totalUSD: number, shared: SharedSpend) {
    super(totalUSD, shared, null);
    this.totalUSD = totalUSD;
  }

  totalSpentUSD(): number {
    return this.shared.spent;
  }

  exhausted(): boolean {
    return this.totalSpentUSD() >= this.totalUSD - METER_EXHAUSTION_EPSILON_USD;
  }
}

function clampFraction(fraction: number | undefined): number {
  if (fraction === undefined || !Number.isFinite(fraction)) {
    return DEFAULT_GRANT_FRACTION;
  }
  return Math.min(1, Math.max(0.01, fraction));
}

export function createBudgetMeter(totalUSD: number): BudgetMeter {
  if (!Number.isFinite(totalUSD) || totalUSD <= 0) {
    throw new Error(`budget: totalUSD must be > 0 (got ${totalUSD})`);
  }
  return new RootMeter(totalUSD, { spent: 0 });
}

export async function withGrant<T>(
  reserve: BudgetGrant,
  opts: GrantOptions,
  fn: (grant: BudgetGrant) => Promise<T>,
): Promise<T | null> {
  const grant = reserve.grant(opts);
  if (!grant) return null;
  try {
    return await fn(grant);
  } finally {
    grant.release();
  }
}
