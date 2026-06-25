import { describe, expect, it } from "vitest";
import { z } from "zod";
import { researchTool, resolveCustomTools } from "./custom-tools.js";
import { ConfigError } from "./errors.js";

const tool = researchTool({
  description: "test tool",
  inputSchema: z.object({ query: z.string() }),
  execute: async () => "ok",
});

describe("resolveCustomTools", () => {
  it("resolves a valid tool name", async () => {
    const resolved = await resolveCustomTools({ pubmed_search: tool });
    expect(resolved.get("pubmed_search")?.name).toBe("pubmed_search");
  });

  it("rejects names that shadow builtin tools", async () => {
    await expect(resolveCustomTools({ fetch: tool })).rejects.toThrow(
      ConfigError,
    );
    await expect(resolveCustomTools({ note: tool })).rejects.toThrow(
      /shadow/,
    );
  });

  it("rejects invalid tool identifiers", async () => {
    await expect(resolveCustomTools({ "9 bad name!": tool })).rejects.toThrow(
      /invalid/,
    );
  });
});
