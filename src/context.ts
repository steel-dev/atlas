import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  createConcurrencyGate,
  createDynamicConcurrencyGate,
  createAdaptiveLimit,
  type AdaptiveLimit,
  type ConcurrencyGate,
} from "./async.js";
import {
  createBudgetMeter,
  DEFAULT_PRICING,
  type BudgetGrant,
  type BudgetMeter,
  type PricingTable,
} from "./budget.js";
import type { AtlasConfig, ResolvedRunConfig, SearchConfig } from "./config.js";
import { resolveCustomTools } from "./custom-tools.js";
import { ECONOMY } from "./economy.js";
import type { EventHub } from "./event-hub.js";
import type { ResearchEvent } from "./events.js";
import {
  createModelCallCache,
  createRunUsage,
  engineModel,
  totalFreshTokens,
  type ModelRole,
  type RateLimitNotice,
} from "./model.js";
import { isSmallModelId } from "./defaults.js";
import { defaultFetchProviders } from "./providers/fetch.js";
import {
  combineSearchProviders,
  defaultSearchProviders,
  type ResolvedSearch,
  type SearchProvider,
} from "./providers/search.js";
import type { JournalWriter, ReplayCache } from "./providers/store.js";
import {
  createRunCounters,
  createSourceStore,
  type RunCtx,
  type SourceStore,
} from "./state.js";
import { isRunCodeAvailable } from "./sandbox.js";
import { createTrail } from "./trail.js";
import { createTraceRecorder } from "./trace.js";

const TIMEOUT_SYNTHESIS_RESERVE_MS = 120_000;
const BUDGET_WARNING_FRACTIONS = [0.5, 0.8, 0.95];
const UNJOURNALED_EVENTS = new Set<ResearchEvent["type"]>([
  "report.delta",
  "report.reset",
]);

interface ModelTier {
  gate: ConcurrencyGate;
  onCost: () => void;
  onRateLimit: (notice: RateLimitNotice) => void;
}

export interface AssembleRunArgs {
  runId: string;
  question: string;
  todayISO: string;
  resolved: ResolvedRunConfig;
  config: AtlasConfig;
  journal: JournalWriter;
  replay?: ReplayCache | undefined;
  hub: EventHub;
  hardSignal: AbortSignal;
  stopSignal: AbortSignal;
  now: () => number;
  startedAt: number;
}

export interface RunAssembly {
  rctx: RunCtx;
  meter: BudgetMeter;
  synthesisGrant: BudgetGrant;
}

export async function assembleRun(args: AssembleRunArgs): Promise<RunAssembly> {
  const { runId, question, resolved } = args;
  const meter = createBudgetMeter(resolved.budgetUSD);
  const usage = createRunUsage();
  const pricing: PricingTable = { ...DEFAULT_PRICING, ...resolved.pricing };
  const makeModelLimit = (): AdaptiveLimit =>
    createAdaptiveLimit({
      start: resolved.maxConcurrentModelCalls,
      min: Math.min(2, resolved.maxConcurrentModelCalls),
      max: resolved.maxConcurrentModelCalls * 2,
    });
  const heavyLimit = makeModelLimit();
  const smallLimit = makeModelLimit();
  const ioGate = createConcurrencyGate(resolved.maxConcurrentIo);
  const modelCache = createModelCallCache();
  const callOrdinals = new Map<string, number>();
  const counters = createRunCounters();
  const warnedUnknownModels = new Set<string>();
  const warnedFractions = new Set<number>();
  const deadlineAt = resolved.maxDurationMs
    ? args.startedAt + resolved.maxDurationMs
    : undefined;
  const recorder =
    resolved.trace !== "off"
      ? createTraceRecorder({
          mode: resolved.trace,
          now: args.now,
          startedAt: args.startedAt,
        })
      : undefined;
  recorder?.setSink((kind, _id, data) => args.journal.trace(kind, data));

  const budgetExhausted = (): boolean => meter.exhausted();
  const tokensExhausted = (): boolean =>
    totalFreshTokens(usage) >= resolved.maxTokens;

  const emit = (event: ResearchEvent): void => {
    args.hub.emit(event);
    if (!UNJOURNALED_EVENTS.has(event.type)) {
      args.journal.event(event.type, event);
    }
  };

  const trackGateWidth = (): void => {
    counters.modelGatePeakWidth = Math.max(
      counters.modelGatePeakWidth,
      heavyLimit.value() + smallLimit.value(),
    );
  };
  const emitBudgetWarnings = (): void => {
    const fraction = meter.totalSpentUSD() / meter.totalUSD;
    for (const threshold of BUDGET_WARNING_FRACTIONS) {
      if (fraction >= threshold && !warnedFractions.has(threshold)) {
        warnedFractions.add(threshold);
        emit({
          type: "budget.warning",
          spentUSD: meter.totalSpentUSD(),
          limitUSD: meter.totalUSD,
          fraction: threshold,
        });
      }
    }
  };
  const makeTier = (limit: AdaptiveLimit): ModelTier => ({
    gate: createDynamicConcurrencyGate(() => limit.value()),
    onCost: () => {
      limit.onSuccess();
      trackGateWidth();
      emitBudgetWarnings();
    },
    onRateLimit: ({ delayMs }: RateLimitNotice) => {
      limit.onThrottle();
      emit({
        type: "rate.limited",
        retryAfterSeconds: Math.max(1, Math.round(delayMs / 1000)),
      });
    },
  });
  const heavyTier = makeTier(heavyLimit);
  const smallTier = makeTier(smallLimit);
  const tierForRole = (role: ModelRole): ModelTier =>
    isSmallModelId((resolved.models[role] as LanguageModelV3).modelId ?? "")
      ? smallTier
      : heavyTier;

  const onUnknownModel = (modelId: string): void => {
    if (warnedUnknownModels.has(modelId)) return;
    warnedUnknownModels.add(modelId);
    emit({
      type: "pricing.missing",
      modelId,
      detail: `no pricing entry for model "${modelId}"; charging conservative default rates`,
    });
  };
  const bindModelWithTier = (
    role: ModelRole,
    grant: BudgetGrant,
    tier: ModelTier,
  ) =>
    engineModel(resolved.models[role], {
      role,
      grant,
      pricing,
      gate: tier.gate,
      usage,
      journal: args.journal,
      replay: args.replay,
      modelCache,
      callOrdinals,
      recorder,
      onCost: tier.onCost,
      onUnknownModel,
      onRateLimit: tier.onRateLimit,
      onCacheHit: () => {
        counters.modelCacheHits++;
      },
      budgetExhausted: () => grant.spentUSD() >= grant.limitUSD,
    });
  const bindModel = (role: ModelRole, grant: BudgetGrant) =>
    bindModelWithTier(role, grant, tierForRole(role));

  const { search, searchBySource } = resolveSearchConfig(args.config.search, () =>
    defaultSearchProviders(
      bindModelWithTier("research", meter, tierForRole("research")),
    ),
  );
  const fetchChain = Array.isArray(args.config.fetch)
    ? args.config.fetch
    : args.config.fetch
      ? [args.config.fetch]
      : defaultFetchProviders();
  const customTools = await resolveCustomTools(args.config.tools);
  const runCodeEnabled = await isRunCodeAvailable();

  const synthesisGrant =
    meter.grant({
      fraction: ECONOMY.synthesis.fraction,
      minUSD: ECONOMY.synthesis.minUSD,
    }) ?? meter;
  const rctx: RunCtx = {
    runId,
    question,
    todayISO: args.todayISO,
    config: resolved,
    meter,
    usage,
    pricing,
    ledger: null,
    trail: createTrail(),
    notes: [],
    readCounts: new Map(),
    sources: createSourceStore(),
    search,
    searchBySource,
    oaCandidates: new Map(),
    surfacedCandidates: new Map(),
    fetchChain,
    customTools,
    runCodeEnabled,
    emit,
    journal: args.journal,
    replay: args.replay,
    recorder,
    signal: args.hardSignal,
    stopSignal: args.stopSignal,
    deadlineAt,
    now: args.now,
    modelGate: heavyTier.gate,
    ioGate,
    seenDomains: new Set(),
    counters,
    agentSequence: { next: 1 },
    bindModel,
    rawModel: (role: ModelRole) => resolved.models[role],
    stopReason: () => {
      if (args.stopSignal.aborted) return "stop requested";
      if (
        deadlineAt !== undefined &&
        args.now() > deadlineAt - TIMEOUT_SYNTHESIS_RESERVE_MS
      ) {
        return "timeout approaching";
      }
      if (budgetExhausted()) return "budget exhausted";
      if (tokensExhausted()) return "token budget reached";
      return null;
    },
  };


  if (args.replay) primeSourceNumbers(rctx.sources, args.replay);

  return {
    rctx,
    meter,
    synthesisGrant,
  };
}

function isSearchProvider(value: unknown): value is SearchProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { search?: unknown }).search === "function"
  );
}

function resolveSearchConfig(
  raw: SearchConfig | undefined,
  webFallback: () => SearchProvider[],
): { search: ResolvedSearch; searchBySource: Map<string, ResolvedSearch> } {
  const flat = (
    providers: SearchProvider[],
  ): { search: ResolvedSearch; searchBySource: Map<string, ResolvedSearch> } => {
    const web = combineSearchProviders(
      providers.length > 0 ? providers : webFallback(),
    );
    return { search: web, searchBySource: new Map([["web", web]]) };
  };
  if (raw === undefined) return flat([]);
  if (isSearchProvider(raw)) return flat([raw]);
  if (Array.isArray(raw)) return flat(raw);
  const searchBySource = new Map<string, ResolvedSearch>();
  for (const [source, value] of Object.entries(raw)) {
    const providers = Array.isArray(value) ? value : [value];
    if (providers.length > 0) {
      searchBySource.set(source, combineSearchProviders(providers));
    }
  }
  if (!searchBySource.has("web")) {
    searchBySource.set("web", combineSearchProviders(webFallback()));
  }
  return { search: searchBySource.get("web")!, searchBySource };
}

function primeSourceNumbers(sources: SourceStore, replay: ReplayCache): void {
  let max = 0;
  for (const prefix of ["fetch:", "custom-source:"]) {
    for (const value of replay.values(prefix)) {
      const sourceId = (value as { sourceId?: unknown } | undefined)?.sourceId;
      const match =
        typeof sourceId === "string" ? /^source_(\d+)$/.exec(sourceId) : null;
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  if (max >= sources.nextSourceNumber) sources.nextSourceNumber = max + 1;
}

export function deriveChildCtx(parent: RunCtx, question: string): RunCtx {
  return {
    ...parent,
    question,
    ledger: null,
    trail: createTrail(),
    notes: [],
    readCounts: new Map(),
    sources: createSourceStore(),
    oaCandidates: new Map(),
    surfacedCandidates: new Map(),
    seenDomains: new Set(),
  };
}
