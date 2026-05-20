import { describe, expect, it } from "vitest";
import { parseCitations } from "./pipeline.js";

describe("parseCitations", () => {
  it("parses a single trailing citation", () => {
    const out = parseCitations("Foo bar [1].");
    expect(out).toEqual([{ text: "Foo bar [1].", source_n: 1 }]);
  });

  it("explodes a multi-source citation into one entry per source", () => {
    const out = parseCitations("Foo [1, 2].");
    expect(out).toEqual([
      { text: "Foo [1, 2].", source_n: 1 },
      { text: "Foo [1, 2].", source_n: 2 },
    ]);
  });

  it("separates citations across sentences", () => {
    const out = parseCitations("First claim [1]. Second claim [2].");
    expect(out).toEqual([
      { text: "First claim [1].", source_n: 1 },
      { text: "Second claim [2].", source_n: 2 },
    ]);
  });

  it("excludes the Sources section", () => {
    const md =
      "Body claim [1].\n\n## Sources\n[1] Title — https://example.com\n[2] Other — https://x.test";
    const out = parseCitations(md);
    expect(out).toHaveLength(1);
    expect(out[0].source_n).toBe(1);
    expect(out[0].text).toBe("Body claim [1].");
  });

  it("does not match markdown links with non-digit text", () => {
    const out = parseCitations("See [docs](https://x) and [1].");
    expect(out).toHaveLength(1);
    expect(out[0].source_n).toBe(1);
  });

  it("returns empty when no citations present", () => {
    expect(parseCitations("Plain prose, no citations here.")).toEqual([]);
  });

  it("handles a citation inside a heading", () => {
    const out = parseCitations("## Findings [1]\n\nBody.");
    expect(out).toHaveLength(1);
    expect(out[0].source_n).toBe(1);
    expect(out[0].text).toContain("[1]");
  });

  it("ignores zero / non-positive citation numbers", () => {
    const out = parseCitations("Bad [0]. Good [3].");
    expect(out).toHaveLength(1);
    expect(out[0].source_n).toBe(3);
  });

  it("survives a citation at the very start", () => {
    const out = parseCitations("[1] anchors the intro.");
    expect(out).toEqual([{ text: "[1] anchors the intro.", source_n: 1 }]);
  });
});
