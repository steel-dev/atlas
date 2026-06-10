import { createHash } from "node:crypto";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { ConcurrencyGate } from "./async.js";
import {
  addTokenUsage,
  emptyTokenUsage,
  resolvePricing,
  usageCostUSD,
  type BudgetGrant,
  type PricingTable,
  type TokenUsage,
} from "./budget.js";
import type { JournalWriter, ReplayCache } from "./providers/store.js";

export type ModelRole = "lead" | "research" | "verify" | "extract" | "write";

export type ResolvedModel = Exclude<LanguageModel, string>;

export interface RunUsage {
  byRole: Map<string, TokenUsage>;
}

export function createRunUsage(): RunUsage {
  return { byRole: new Map() };
}

function trackUsage(runUsage: RunUsage, role: string, usage: TokenUsage): void {
  const existing = runUsage.byRole.get(role) ?? emptyTokenUsage();
  addTokenUsage(existing, usage);
  runUsage.byRole.set(role, existing);
}

export function tokenUsageFromV3(usage: LanguageModelV3Usage): TokenUsage {
  const cacheRead = usage.inputTokens.cacheRead ?? 0;
  const cacheWrite = usage.inputTokens.cacheWrite ?? 0;
  const input =
    usage.inputTokens.noCache ??
    Math.max(0, (usage.inputTokens.total ?? 0) - cacheRead - cacheWrite);
  return {
    input,
    output: usage.outputTokens.total ?? 0,
    cacheRead,
    cacheWrite,
  };
}

export interface EngineModelHooks {
  role: ModelRole;
  grant: BudgetGrant;
  pricing: PricingTable;
  gate: ConcurrencyGate;
  usage: RunUsage;
  journal?: JournalWriter | undefined;
  replay?: ReplayCache | undefined;
  onCost?: ((usd: number) => void) | undefined;
  onUnknownModel?: ((modelId: string) => void) | undefined;
}

function callKey(
  model: LanguageModelV3,
  params: LanguageModelV3CallOptions,
  role: string,
): string {
  const material = {
    role,
    provider: model.provider,
    modelId: model.modelId,
    prompt: params.prompt,
    tools: params.tools?.map((tool) => ({
      type: tool.type,
      name: "name" in tool ? tool.name : undefined,
      description: "description" in tool ? tool.description : undefined,
      inputSchema: "inputSchema" in tool ? tool.inputSchema : undefined,
    })),
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
    maxOutputTokens: params.maxOutputTokens,
  };
  return createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")
    .slice(0, 40);
}

interface JournaledCall {
  content: LanguageModelV3GenerateResult["content"];
  finishReason: LanguageModelV3GenerateResult["finishReason"];
  usage: LanguageModelV3Usage;
  providerMetadata?: LanguageModelV3GenerateResult["providerMetadata"];
}

function serializeResult(
  result: LanguageModelV3GenerateResult,
): JournaledCall | null {
  const record: JournaledCall = {
    content: result.content,
    finishReason: result.finishReason,
    usage: result.usage,
    ...(result.providerMetadata
      ? { providerMetadata: result.providerMetadata }
      : {}),
  };
  try {
    JSON.stringify(record);
    return record;
  } catch {
    return null;
  }
}

function isAnthropicModel(model: LanguageModelV3): boolean {
  return model.provider.toLowerCase().includes("anthropic");
}

function withCacheBreakpoint(
  params: LanguageModelV3CallOptions,
): LanguageModelV3CallOptions {
  if (params.prompt.length === 0) return params;
  const prompt = [...params.prompt];
  const last = prompt[prompt.length - 1];
  prompt[prompt.length - 1] = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      anthropic: {
        ...last.providerOptions?.anthropic,
        cacheControl: { type: "ephemeral" },
      },
    },
  } as typeof last;
  return { ...params, prompt };
}

export function engineModel(
  model: ResolvedModel,
  hooks: EngineModelHooks,
): LanguageModelV3 {
  const inner = model as LanguageModelV3;
  const settle = (usage: LanguageModelV3Usage): void => {
    const tokens = tokenUsageFromV3(usage);
    const { pricing, known } = resolvePricing(inner.modelId, hooks.pricing);
    if (!known) hooks.onUnknownModel?.(inner.modelId);
    const cost = usageCostUSD(tokens, pricing);
    hooks.grant.charge(cost);
    trackUsage(hooks.usage, hooks.role, tokens);
    hooks.onCost?.(cost);
  };

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) =>
      isAnthropicModel(inner) ? withCacheBreakpoint(params) : params,
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = callKey(inner, params, hooks.role);
      const cached = hooks.replay?.take(key) as JournaledCall | undefined;
      if (cached) {
        return {
          content: cached.content,
          finishReason: cached.finishReason,
          usage: cached.usage,
          ...(cached.providerMetadata
            ? { providerMetadata: cached.providerMetadata }
            : {}),
          warnings: [],
        };
      }
      const result = await hooks.gate.run(() => Promise.resolve(doGenerate()));
      settle(result.usage);
      if (hooks.journal) {
        const record = serializeResult(result);
        if (record) hooks.journal.call(key, record);
      }
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await hooks.gate.run(() => Promise.resolve(doStream()));
      const metered = result.stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(part, controller) {
            if (part.type === "finish") settle(part.usage);
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream: metered };
    },
  };

  return wrapLanguageModel({ model: inner, middleware }) as LanguageModelV3;
}

export const MODEL_CALL_MAX_RETRIES = 5;
