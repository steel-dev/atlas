import { describe, expect, it, vi } from "vitest";
import { jsonSchema } from "ai";
import { Atlas } from "./atlas.js";
import { synthesizeStructured, __testing } from "./structured.js";
import type { ResearchClaim } from "./claims.js";
import type { ResearchCtx } from "./runtime.js";

async function _structuredOverloadTypeCheck(atlas: Atlas): Promise<number> {
  const result = await atlas.research({
    query: "q",
    outputSchema: jsonSchema<{ count: number }>({ type: "object" }),
  });
  const citations = result.basis["count"].citations;
  void citations;
  return result.data.count;
}
void _structuredOverloadTypeCheck;

function claim(partial: Partial<ResearchClaim>): ResearchClaim {
  return {
    id: "c",
    text: "claim text",
    quote: "quote",
    importance: "central",
    sourceQuality: "primary",
    sourceId: "s",
    url: "https://example.com",
    title: "Example",
    status: "confirmed",
    votes: [],
    ...partial,
  };
}

function ctxReturning(texts: string[]): ResearchCtx {
  const step = vi.fn();
  for (const text of texts) {
    step.mockResolvedValueOnce({ content: [{ type: "text", text }] });
  }
  return {
    config: {},
    deps: { model: { step }, signal: undefined },
  } as unknown as ResearchCtx;
}

const FRAMEWORK_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    frameworks: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, license: { type: "string" } },
      },
    },
  },
});

describe("leafPaths", () => {
  it("walks nested objects and arrays to terminal field paths", () => {
    expect(
      __testing.leafPaths({ frameworks: [{ name: "X", license: "MIT" }] }),
    ).toEqual(["frameworks.0.name", "frameworks.0.license"]);
  });

  it("treats scalars and null as leaves and skips empty containers", () => {
    expect(__testing.leafPaths({ a: 1, b: { c: null }, d: [] })).toEqual([
      "a",
      "b.c",
    ]);
  });
});

describe("synthesizeStructured", () => {
  it("returns typed data and grounds each field in the cited claim", async () => {
    const data = {
      frameworks: [{ name: "GPT-Researcher", license: "Apache-2.0" }],
    };
    const attribution = {
      fields: [
        {
          path: "frameworks.0.license",
          claims: [0],
          reasoning: "LICENSE file states Apache-2.0.",
        },
      ],
    };
    const ctx = ctxReturning([
      JSON.stringify(data),
      JSON.stringify(attribution),
    ]);

    const result = await synthesizeStructured(ctx, {
      question: "compare frameworks",
      schema: FRAMEWORK_SCHEMA,
      confirmed: [
        claim({
          quote: "Apache License, Version 2.0",
          url: "https://gh/license",
          title: "LICENSE",
          sourceId: "s0",
        }),
      ],
      candidates: [],
    });

    expect(result.data).toEqual(data);
    expect(result.basis["frameworks.0.license"]).toEqual({
      citations: [
        {
          sourceId: "s0",
          url: "https://gh/license",
          title: "LICENSE",
          excerpt: "Apache License, Version 2.0",
        },
      ],
      reasoning: "LICENSE file states Apache-2.0.",
    });
  });

  it("pre-seeds every leaf field so ungrounded fields are transparent", async () => {
    const data = { frameworks: [{ name: "X", license: "MIT" }] };
    const attribution = {
      fields: [{ path: "frameworks.0.license", claims: [0], reasoning: "ok" }],
    };
    const ctx = ctxReturning([
      JSON.stringify(data),
      JSON.stringify(attribution),
    ]);

    const result = await synthesizeStructured(ctx, {
      question: "q",
      schema: FRAMEWORK_SCHEMA,
      confirmed: [claim({ url: "https://u", title: "t", sourceId: "s0" })],
      candidates: [],
    });

    expect(result.basis["frameworks.0.name"].citations).toEqual([]);
    expect(result.basis["frameworks.0.name"].reasoning).toMatch(/unverified/i);
  });

  it("ignores hallucinated paths and out-of-range claim indices", async () => {
    const data = { frameworks: [{ name: "X", license: "MIT" }] };
    const attribution = {
      fields: [
        { path: "frameworks.0.bogus", claims: [0], reasoning: "nope" },
        { path: "frameworks.0.license", claims: [99], reasoning: "weak" },
      ],
    };
    const ctx = ctxReturning([
      JSON.stringify(data),
      JSON.stringify(attribution),
    ]);

    const result = await synthesizeStructured(ctx, {
      question: "q",
      schema: FRAMEWORK_SCHEMA,
      confirmed: [claim({ sourceId: "s0" })],
      candidates: [],
    });

    expect(result.basis["frameworks.0.bogus"]).toBeUndefined();
    expect(result.basis["frameworks.0.license"].citations).toEqual([]);
  });

  it("keeps best-effort basis when the attribution pass fails", async () => {
    const data = { frameworks: [{ name: "X", license: "MIT" }] };
    const step = vi.fn();
    step.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(data) }],
    });
    step.mockRejectedValueOnce(new Error("attribution boom"));
    const ctx = {
      config: {},
      deps: { model: { step }, signal: undefined },
    } as unknown as ResearchCtx;

    const result = await synthesizeStructured(ctx, {
      question: "q",
      schema: FRAMEWORK_SCHEMA,
      confirmed: [claim({})],
      candidates: [],
    });

    expect(result.data).toEqual(data);
    expect(result.basis["frameworks.0.license"].citations).toEqual([]);
  });

  it("throws when the data pass returns invalid JSON", async () => {
    const ctx = ctxReturning(["not json"]);
    await expect(
      synthesizeStructured(ctx, {
        question: "q",
        schema: FRAMEWORK_SCHEMA,
        confirmed: [],
        candidates: [],
      }),
    ).rejects.toThrow(/structured output/);
  });
});
