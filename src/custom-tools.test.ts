import { describe, expect, it } from "vitest";
import { jsonSchema } from "ai";
import {
  addToolSource,
  resolveCustomTools,
  researchTool,
} from "./custom-tools.js";
import { executeResearchTool } from "./tool-registry.js";
import { createToolTestContext } from "./test-harness.js";
import type { ResearchCtx } from "./runtime.js";

function toolCall(name: string, input: unknown) {
  return { type: "tool_call" as const, id: "call_1", name, input };
}

const extras = { searchIndexRef: { next: 0 }, surveyedGoals: [] };

describe("resolveCustomTools", () => {
  it("uses the config key as the tool name and normalizes the input schema", async () => {
    const map = await resolveCustomTools({
      pubmedSearch: researchTool({
        description: "Search PubMed.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { query: { type: "string" } },
        }),
        execute: () => "ok",
      }),
    });

    const tool = map.get("pubmedSearch");
    expect(tool?.definition.name).toBe("pubmedSearch");
    expect(tool?.definition.description).toBe("Search PubMed.");
    expect(tool?.definition.input_schema).toMatchObject({ type: "object" });
  });
});

describe("addToolSource", () => {
  it("stores a citable source document and queues claim extraction", () => {
    const ctx = createToolTestContext({ sourceCap: 4 });
    const document = addToolSource(ctx, {
      url: "https://pubmed.ncbi.nlm.nih.gov/123",
      title: "A study",
      content: "SGLT2 inhibitors reduced HF hospitalizations.",
      toolName: "pubmedSearch",
    });

    expect(document).not.toBeNull();
    expect(ctx.store.fetchedSources).toEqual([
      {
        url: "https://pubmed.ncbi.nlm.nih.gov/123",
        title: "A study",
        sourceId: document!.sourceId,
        canonicalUrl: document!.canonicalUrl,
      },
    ]);
    expect(ctx.store.sourceDocumentsById.get(document!.sourceId)).toBe(document);
    expect(ctx.queueSpy).toHaveBeenCalledWith(ctx, document);
    expect(ctx.emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "source_fetched", method: "custom_tool" }),
    );
  });

  it("dedupes by URL and respects the source cap", () => {
    const ctx = createToolTestContext({ sourceCap: 1 });
    const first = addToolSource(ctx, {
      url: "https://a.test",
      content: "alpha",
      toolName: "t",
    });
    const dupe = addToolSource(ctx, {
      url: "https://a.test",
      content: "alpha again",
      toolName: "t",
    });
    const overCap = addToolSource(ctx, {
      url: "https://b.test",
      content: "beta",
      toolName: "t",
    });

    expect(dupe).toBe(first);
    expect(overCap).toBeNull();
    expect(ctx.store.fetchedSources).toHaveLength(1);
  });

  it("skips empty content", () => {
    const ctx = createToolTestContext({ sourceCap: 4 });
    expect(
      addToolSource(ctx, { url: "https://a.test", content: "  ", toolName: "t" }),
    ).toBeNull();
    expect(ctx.store.fetchedSources).toHaveLength(0);
  });
});

describe("executeResearchTool with custom tools", () => {
  it("dispatches to a registered custom tool and returns its output", async () => {
    const ctx = createToolTestContext({ sourceCap: 4 }) as ResearchCtx;
    ctx.tools = await resolveCustomTools({
      pubmedSearch: researchTool({
        description: "Search PubMed.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: (_input, toolCtx) => {
          toolCtx.addSource({
            url: "https://pubmed.ncbi.nlm.nih.gov/999",
            title: "Trial",
            content: "Primary endpoint met.",
          });
          return "- Trial — https://pubmed.ncbi.nlm.nih.gov/999";
        },
      }),
    });

    const { toolResult } = await executeResearchTool(
      toolCall("pubmedSearch", { query: "sglt2" }),
      ctx,
      extras,
    );

    expect(toolResult.is_error).toBeUndefined();
    expect(toolResult.content).toContain("pubmed.ncbi.nlm.nih.gov/999");
    expect(ctx.store.fetchedSources).toHaveLength(1);
  });

  it("reports an unknown tool with the registered custom names listed", async () => {
    const ctx = createToolTestContext({ sourceCap: 4 }) as ResearchCtx;
    ctx.tools = await resolveCustomTools({
      pubmedSearch: researchTool({
        description: "Search PubMed.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => "ok",
      }),
    });

    const { toolResult } = await executeResearchTool(
      toolCall("nope", {}),
      ctx,
      extras,
    );

    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("pubmedSearch");
  });

  it("turns a thrown custom-tool error into a recoverable tool result", async () => {
    const ctx = createToolTestContext({ sourceCap: 4 }) as ResearchCtx;
    ctx.tools = await resolveCustomTools({
      boom: researchTool({
        description: "Always fails.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => {
          throw new Error("upstream 500");
        },
      }),
    });

    const { toolResult } = await executeResearchTool(
      toolCall("boom", {}),
      ctx,
      extras,
    );

    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("upstream 500");
  });
});
