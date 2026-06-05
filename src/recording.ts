import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ModelAdapter,
  ModelAssistantBlock,
  ModelMessage,
  ModelStepInput,
  ModelStepResult,
  ModelToolDefinition,
} from "./model.js";

/**
 * One recorded model invocation — byte-exact: the full input the model saw
 * (system prompt + the whole message thread, with prior tool results inline)
 * and the assistant blocks it produced (thinking, text, tool calls). This is
 * the atomic unit of a run transcript; the messages array is cumulative, so a
 * later step's `messages` already contains everything earlier steps saw plus
 * the tool results fed back in between.
 */
export interface RecordedStep {
  seq: number;
  /** Milliseconds since the recorder started. */
  atMs: number;
  /**
   * Semantic role of the call site — e.g. "lead", "recall.scope",
   * "extract", "verify:<claimId>", "synthesis.prose". Set via {@link withRole};
   * falls back to the adapter label ("lead" / "leaf") when unset.
   */
  role: string;
  /** Which adapter served the call. */
  adapter: "lead" | "leaf";
  /** Wall-clock for the call, including gate waiting and retries. */
  durationMs: number;
  system: string;
  messages: ModelMessage[];
  /** Tool names offered on this step (schemas live in source, not recorded). */
  toolNames?: string[];
  maxTokens: number;
  /** Name of the structured-output schema, when the step was a generateObject. */
  outputSchema?: string;
  output: ModelAssistantBlock[];
  /** Input tokens for this single call, as reported by the provider. */
  inputTokens?: number;
  /** Set instead of `output` when the call threw after exhausting retries. */
  error?: string;
}

interface RoleContext {
  role: string;
}

const roleStore = new AsyncLocalStorage<RoleContext>();

/**
 * Runs `fn` with an ambient role tag that {@link wrapModelAdapterWithRecording}
 * stamps onto every step taken inside it (including awaited and concurrently
 * spawned model calls). Nesting replaces the tag for the inner scope.
 */
export function withRole<T>(role: string, fn: () => T): T {
  return roleStore.run({ role }, fn);
}

export function currentRole(): string | undefined {
  return roleStore.getStore()?.role;
}

/** Collects the ordered transcript of every model step taken during a run. */
export class StepRecorder {
  readonly steps: RecordedStep[] = [];
  private readonly startedAt: number;
  private seq = 0;

  constructor(startedAt: number = Date.now()) {
    this.startedAt = startedAt;
  }

  record(step: Omit<RecordedStep, "seq" | "atMs">): void {
    this.steps.push({
      seq: this.seq++,
      atMs: Date.now() - this.startedAt,
      ...step,
    });
  }
}

function toolNamesOf(
  tools: ModelToolDefinition[] | undefined,
): string[] | undefined {
  return tools && tools.length > 0 ? tools.map((t) => t.name) : undefined;
}

// The lead loop reuses and mutates its `messages` array after handing it to
// step(), so we must snapshot it at record time or the transcript would show
// every step's input as the final, fully-grown thread.
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Wraps an adapter so every `step()` / `stepStream()` call is appended to
 * `recorder` byte-exact: the input the model saw and the blocks it produced,
 * tagged with the ambient {@link withRole} (or `label` as a fallback). The
 * wrapper is transparent — provider, model, usage object reference, retries,
 * and return values are all unchanged. Wrap this OUTSIDE the concurrency
 * wrapper so each logical step records once, after retries settle.
 */
export function wrapModelAdapterWithRecording(
  adapter: ModelAdapter,
  recorder: StepRecorder,
  label: "lead" | "leaf",
): ModelAdapter {
  const capture = async (
    input: ModelStepInput,
    run: () => Promise<ModelStepResult>,
  ): Promise<ModelStepResult> => {
    const startedAt = Date.now();
    const role = currentRole() ?? label;
    const base = {
      role,
      adapter: label,
      system: input.system,
      messages: snapshot(input.messages),
      ...(toolNamesOf(input.tools) ? { toolNames: toolNamesOf(input.tools) } : {}),
      maxTokens: input.maxTokens,
      ...(input.outputSchema ? { outputSchema: input.outputSchema.name } : {}),
    };
    try {
      const result = await run();
      recorder.record({
        ...base,
        durationMs: Date.now() - startedAt,
        output: snapshot(result.content),
        ...(result.inputTokens !== undefined
          ? { inputTokens: result.inputTokens }
          : {}),
      });
      return result;
    } catch (err) {
      recorder.record({
        ...base,
        durationMs: Date.now() - startedAt,
        output: [],
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const innerStepStream = adapter.stepStream?.bind(adapter);
  return {
    provider: adapter.provider,
    model: adapter.model,
    usage: adapter.usage,
    step: (input) => capture(input, () => adapter.step(input)),
    ...(innerStepStream
      ? {
          stepStream: (input, callbacks) =>
            capture(input, () => innerStepStream(input, callbacks)),
        }
      : {}),
  };
}
