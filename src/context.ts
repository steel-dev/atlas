import { createConcurrencyGate, type ConcurrencyGate } from "./async.js";
import {
  createBudgetMeter,
  DEFAULT_PRICING,
  type BudgetGrant,
  type BudgetMeter,
  type PricingTable,
} from "./budget.js";
import type { AtlasConfig, ResolvedRunConfig } from "./config.js";
import { resolveCustomTools } from "./custom-tools.js";
import { ECONOMY } from "./economy.js";
import type { EventHub } from "./event-hub.js";
import type { ResearchEvent } from "./events.js";
import { createLedger, type ResearchClaim } from "./ledger.js";
import {
  createRunUsage,
  engineModel,
  totalFreshTokens,
  type ModelRole,
} from "./model.js";
import { defaultFetchProviders } from "./providers/fetch.js";
import {
  combineSearchProviders,
  defaultSearchProviders,
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
import { runVerifySpawn } from "./verify.js";

const TIMEOUT_SYNTHESIS_RESERVE_MS = 120_000;
const BUDGET_WARNING_FRACTIONS = [0.5, 0.8, 0.95];
const UNJOURNALED_EVENTS = new Set<ResearchEvent["type"]>([
  "report.delta",
  "report.reset",
]);

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
  verifyReserve: BudgetGrant;
  drainEagerVerifications(): Promise<void>;
}

export async function assembleRun(args: AssembleRunArgs): Promise<RunAssembly> {
  const { runId, question, resolved } = args;
  const meter = createBudgetMeter(resolved.budgetUSD);
  const usage = createRunUsage();
  const pricing: PricingTable = { ...DEFAULT_PRICING, ...resolved.pricing };
  const modelGate = createConcurrencyGate(resolved.maxConcurrentModelCalls);
  const ioGate = createConcurrencyGate(resolved.maxConcurrentIo);
  const searchGate = createConcurrencyGate(resolved.maxConcurrentIo);
  const counters = createRunCounters();
  const warnedUnknownModels = new Set<string>();
  const warnedFractions = new Set<number>();
  const deadlineAt = resolved.maxDurationMs
    ? args.startedAt + resolved.maxDurationMs
    : undefined;

  const budgetExhausted = (): boolean => meter.exhausted();
  const tokensExhausted = (): boolean =>
    totalFreshTokens(usage) >= resolved.maxTokens;

  const emit = (event: ResearchEvent): void => {
    args.hub.emit(event);
    if (!UNJOURNALED_EVENTS.has(event.type)) {
      args.journal.event(event.type, event);
    }
  };

  const onCost = (): void => {
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

  const onUnknownModel = (modelId: string): void => {
    if (warnedUnknownModels.has(modelId)) return;
    warnedUnknownModels.add(modelId);
    emit({
      type: "pricing.missing",
      modelId,
      detail: `no pricing entry for model "${modelId}"; charging conservative default rates`,
    });
  };
  const onRateLimit = ({ delayMs }: { delayMs: number }): void =>
    emit({
      type: "rate.limited",
      retryAfterSeconds: Math.max(1, Math.round(delayMs / 1000)),
    });
  const bindModelWithGate = (
    role: ModelRole,
    grant: BudgetGrant,
    gate: ConcurrencyGate,
  ) =>
    engineModel(resolved.models[role], {
      role,
      grant,
      pricing,
      gate,
      usage,
      journal: args.journal,
      replay: args.replay,
      onCost,
      onUnknownModel,
      onRateLimit,
    });
  const bindModel = (role: ModelRole, grant: BudgetGrant) =>
    bindModelWithGate(role, grant, modelGate);

  const searchProviders = Array.isArray(args.config.search)
    ? args.config.search
    : args.config.search
      ? [args.config.search]
      : defaultSearchProviders(bindModelWithGate("research", meter, searchGate));
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
  const verifyReserve =
    meter.grant({
      fraction: resolved.envelope.verifyReserveFraction,
      minUSD: ECONOMY.verifyReserve.minUSD,
    }) ?? meter;

  const eagerVerifications = new Set<Promise<void>>();
  let eagerVerifyStarted = 0;
  const ledger = createLedger({
    emit,
    signal: args.hardSignal,
    shouldExtract: () => !budgetExhausted(),
    claimsPerSource: resolved.envelope.maxClaimsPerSource,
    extractionChars: resolved.envelope.maxExtractionChars,
    onClaim: (claim) => eagerVerify(claim),
  });

  const rctx: RunCtx = {
    runId,
    question,
    todayISO: args.todayISO,
    config: resolved,
    meter,
    verifyReserve,
    usage,
    pricing,
    ledger,
    trail: createTrail(),
    sources: createSourceStore(),
    search: combineSearchProviders(searchProviders),
    fetchChain,
    customTools,
    runCodeEnabled,
    emit,
    journal: args.journal,
    replay: args.replay,
    signal: args.hardSignal,
    stopSignal: args.stopSignal,
    deadlineAt,
    now: args.now,
    modelGate,
    ioGate,
    seenDomains: new Set(),
    verifyInFlight: new Map(),
    counters,
    agentSequence: { next: 1 },
    bindModel,
    rawModel: (role: ModelRole) => resolved.models[role],
    verifySpawn: (spawnArgs) => runVerifySpawn(rctx, spawnArgs),
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

  function eagerVerify(claim: ResearchClaim): void {
    if (claim.importance !== "central") return;
    if (eagerVerifyStarted >= ECONOMY.eagerVerifyMaxClaims) return;
    if (rctx.stopReason()) return;
    const grant = verifyReserve.grant({
      fraction: ECONOMY.verifySweep.fraction,
      minUSD: resolved.envelope.panelGrantUSD,
    });
    if (!grant) return;
    eagerVerifyStarted++;
    const task = rctx
      .verifySpawn({
        claimIds: [claim.id],
        grant,
        depth: 1,
      })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => grant.release());
    eagerVerifications.add(task);
    void task.finally(() => eagerVerifications.delete(task));
  }

  if (args.replay) primeSourceNumbers(rctx.sources, args.replay);

  return {
    rctx,
    meter,
    synthesisGrant,
    verifyReserve,
    drainEagerVerifications: async () => {
      while (eagerVerifications.size > 0) {
        await Promise.all([...eagerVerifications]);
      }
    },
  };
}

function primeSourceNumbers(sources: SourceStore, replay: ReplayCache): void {
  let max = 0;
  for (const value of replay.values("fetch:")) {
    const sourceId = (value as { sourceId?: unknown } | undefined)?.sourceId;
    const match =
      typeof sourceId === "string" ? /^source_(\d+)$/.exec(sourceId) : null;
    if (match) max = Math.max(max, Number(match[1]));
  }
  if (max >= sources.nextSourceNumber) sources.nextSourceNumber = max + 1;
}
