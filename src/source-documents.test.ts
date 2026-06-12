import { describe, expect, it } from "vitest";
import {
  createSourceDocument,
  extractionMetadataFromText,
  selectExtractionWindow,
} from "./source-documents.js";

function makeDoc(markdown: string) {
  return createSourceDocument(
    "https://example.com/doc",
    "Doc",
    markdown,
    extractionMetadataFromText({
      markdownChars: markdown.length,
      method: "text_direct",
    }),
    markdown.length,
    "source_1",
  );
}

describe("selectExtractionWindow", () => {
  it("returns the whole document when it fits the budget", () => {
    const doc = makeDoc("short document body");
    const window = selectExtractionWindow(doc, "anything", 40_000);
    expect(window.truncated).toBe(false);
    expect(window.text).toBe("short document body");
  });

  it("pulls a late relevant chunk instead of head-truncating", () => {
    const head = "a".repeat(12_000);
    const middle = "b".repeat(12_000);
    const tail = "GAMMAUNIQUE the measured answer is 42 units. " + "c".repeat(6_000);
    const doc = makeDoc(head + middle + tail);

    const window = selectExtractionWindow(doc, "GAMMAUNIQUE answer", 26_000);

    expect(window.truncated).toBe(true);
    expect(window.text).toContain("GAMMAUNIQUE the measured answer is 42");
    expect(window.text).toContain("[…]");
    expect(window.text).not.toContain("b".repeat(100));
    expect(window.text.length).toBeLessThanOrEqual(26_000);
  });

  it("keeps the lead chunk and stays within budget when nothing matches", () => {
    const doc = makeDoc("x".repeat(30_000));
    const window = selectExtractionWindow(doc, "zzzznomatch", 15_000);
    expect(window.truncated).toBe(true);
    expect(window.text.length).toBeLessThanOrEqual(15_000);
    expect(window.text.startsWith("x")).toBe(true);
  });
});
