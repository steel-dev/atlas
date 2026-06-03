import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import { runResearchLoop } from "./research-loop.js";
import {
  createAgentScope,
  createConcurrencyGate,
  createSourceStore,
  type ResearchCtx,
  type ResearchLoopEvent,
} from "./runtime.js";
import { compileUserTools } from "./tool-registry.js";
import { researchTool, type CompiledUserTool } from "./research-tool.js";
import { createResearcher } from "./researcher.js";
import type {
  LanguageModel,
  ModelAssistantBlock,
  ModelStepInput,
  ModelToolCall,
} from "./model.js";

function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ModelToolCall {
  return { type: "tool_call", id, name, input };
}

function scriptedStep(
  responses: ModelAssistantBlock[][],
): (input: ModelStepInput) => Promise<{ content: ModelAssistantBlock[] }> {
  let call = 0;
  return async () => {
    const content = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { content };
  };
}

function buildCtx(opts: {
  step: (input: ModelStepInput) => Promise<{ content: ModelAssistantBlock[] }>;
  userTools?: ReadonlyMap<string, CompiledUserTool>;
  instructions?: string;
}): { ctx: ResearchCtx; events: ResearchLoopEvent[] } {
  const events: ResearchLoopEvent[] = [];
  const ctx: ResearchCtx = {
    config: {
      useProxy: false,
      sourceCap: 100,
      maxOutputTokens: 2048,
      tokenLimit: 0,
      maxDelegationDepth: 0,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      ...(opts.userTools ? { userTools: opts.userTools } : {}),
    },
    deps: {
      model: {
        provider: "anthropic",
        model: "test-model",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        step: opts.step,
      },
      steel: { sessions: {} } as unknown as ResearchCtx["deps"]["steel"],
      abort: () => {},
      ioGate: createConcurrencyGate(2),
      browserSessionPool:
        {} as unknown as ResearchCtx["deps"]["browserSessionPool"],
    },
    store: createSourceStore(),
    scope: createAgentScope({ sink: (event) => events.push(event), depth: 0 }),
  };
  return { ctx, events };
}

describe("researchTool / compileUserTools", () => {
  it("compiles a tool to a model definition keyed by its name", () => {
    const compiled = compileUserTools({
      grade: researchTool({
        description: "Grade evidence",
        inputSchema: jsonSchema<{ n: number }>({
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        }),
        execute: ({ n }) => `n=${n}`,
      }),
    });
    const def = compiled.get("grade")?.definition;
    expect(def?.name).toBe("grade");
    expect(def?.description).toBe("Grade evidence");
    expect(def?.input_schema).toMatchObject({ type: "object" });
  });

  it("rejects a user tool that shadows a built-in name", () => {
    expect(() =>
      compileUserTools({
        fetch: researchTool({
          description: "x",
          inputSchema: jsonSchema({ type: "object" }),
          execute: () => "y",
        }),
      }),
    ).toThrow(/reserved/);
  });
});

describe("createResearcher", () => {
  const fakeModel = {} as unknown as Exclude<LanguageModel, string>;

  it("validates reserved tool names eagerly at creation", () => {
    expect(() =>
      createResearcher({
        model: fakeModel,
        tools: {
          search: researchTool({
            description: "x",
            inputSchema: jsonSchema({ type: "object" }),
            execute: () => "y",
          }),
        },
      }),
    ).toThrow(/reserved/);
  });

  it("exposes the researcher surface and a disposable close", async () => {
    const researcher = createResearcher({ model: fakeModel });
    expect(typeof researcher.research).toBe("function");
    expect(typeof researcher.stream).toBe("function");
    expect(researcher[Symbol.asyncDispose]).toBe(researcher.close);
    await expect(researcher.close()).resolves.toBeUndefined();
  });
});

describe("user tools in the research loop", () => {
  it("offers the tool, appends instructions, runs execute, and registers a citable source", async () => {
    const calls: ModelStepInput[] = [];
    let step = 0;
    const userTools = compileUserTools({
      addEvidence: researchTool({
        description: "Add a citable source.",
        inputSchema: jsonSchema<{ url: string; title: string }>({
          type: "object",
          properties: { url: { type: "string" }, title: { type: "string" } },
          required: ["url", "title"],
        }),
        execute: ({ url, title }, ctx) => {
          ctx.emit({ phase: "adding" });
          const sourceId = ctx.addSource({
            url,
            title,
            content: "Evidence body about the topic.",
          });
          return `Added ${sourceId}: ${title}`;
        },
      }),
    });

    const { ctx, events } = buildCtx({
      instructions: "You are a clinical evidence analyst.",
      userTools,
      step: async (input) => {
        calls.push(input);
        step += 1;
        if (step === 1) {
          return {
            content: [
              toolCall("c1", "addEvidence", {
                url: "https://example.com/a",
                title: "Study A",
              }),
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "# Report\n\nFinding from https://example.com/a.",
            },
          ],
        };
      },
    });

    const result = await runResearchLoop({ ctx, query: "q", maxToolCalls: 5 });

    expect(result.markdown).toContain("Report");
    expect(calls[0]?.tools?.map((t) => t.name)).toContain("addEvidence");
    expect(calls[0]?.system).toContain("You are a clinical evidence analyst.");

    expect(ctx.store.fetchedSources).toHaveLength(1);
    expect(ctx.store.fetchedSources[0]).toMatchObject({
      url: "https://example.com/a",
      title: "Study A",
    });
    expect(ctx.store.fetchedSources[0]?.sourceId).toBeTruthy();

    const toolEvent = events.find((event) => event.type === "tool_event");
    expect(toolEvent).toMatchObject({
      type: "tool_event",
      tool: "addEvidence",
      data: { phase: "adding" },
    });
  });

  it("registers a citable-only source when a tool omits content", async () => {
    const userTools = compileUserTools({
      cite: researchTool({
        description: "Cite a URL without storing readable content.",
        inputSchema: jsonSchema<{ url: string; title: string }>({
          type: "object",
          properties: { url: { type: "string" }, title: { type: "string" } },
          required: ["url", "title"],
        }),
        execute: ({ url, title }, ctx) => {
          const sourceId = ctx.addSource({ url, title });
          return `cited ${title} (id=${String(sourceId)})`;
        },
      }),
    });

    const { ctx } = buildCtx({
      userTools,
      step: scriptedStep([
        [toolCall("c1", "cite", { url: "https://example.com/b", title: "B" })],
        [{ type: "text", text: "# Report\n\nSee https://example.com/b." }],
      ]),
    });

    await runResearchLoop({ ctx, query: "q", maxToolCalls: 5 });

    expect(ctx.store.fetchedSources).toEqual([
      {
        url: "https://example.com/b",
        title: "B",
        canonicalUrl: "https://example.com/b",
      },
    ]);
    expect(ctx.store.sourceDocuments.size).toBe(0);
  });
});
