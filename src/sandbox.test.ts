import { describe, expect, it } from "vitest";
import { runCodeSandboxed } from "./sandbox.js";

const sources = [
  {
    source_id: "source_1",
    url: "https://example.com",
    title: "Example",
    text: "The price was $42 in 2020 and $58 in 2024.",
  },
];

describe("runCodeSandboxed", () => {
  it("evaluates code over sources out of process", async () => {
    const output = await runCodeSandboxed({
      code: "sources.length",
      sources,
      timeoutMs: 5000,
    });
    expect(output.error).toBeUndefined();
    expect(output.result).toBe(1);
    expect(output.sources_in_scope).toBe(1);
  });

  it("exposes grep with offsets", async () => {
    const output = await runCodeSandboxed({
      code: "grep(/\\$\\d+/g).map(m => m.match)",
      sources,
      timeoutMs: 5000,
    });
    expect(output.result).toEqual(["$42", "$58"]);
  });

  it("captures print output", async () => {
    const output = await runCodeSandboxed({
      code: "print('hello', {a: 1}); 7",
      sources,
      timeoutMs: 5000,
    });
    expect(output.stdout).toContain("hello");
    expect(output.result).toBe(7);
  });

  it("reports thrown errors without crashing", async () => {
    const output = await runCodeSandboxed({
      code: "throw new Error('boom')",
      sources,
      timeoutMs: 5000,
    });
    expect(output.error).toContain("boom");
  });

  it("times out runaway code", async () => {
    const output = await runCodeSandboxed({
      code: "while(true) {}",
      sources,
      timeoutMs: 500,
    });
    expect(output.error).toMatch(/timed out/i);
  }, 15_000);

  it("has no filesystem or process access", async () => {
    const output = await runCodeSandboxed({
      code: "typeof require + ':' + typeof process + ':' + typeof fetch",
      sources,
      timeoutMs: 5000,
    });
    expect(output.result).toBe("undefined:undefined:undefined");
  });
});
