import { describe, it, expect } from "vitest";
import { execRunCode } from "./code-tool.js";
import { createSourceStore, type ResearchCtx } from "./runtime.js";
import { createSourceDocument } from "./source-documents.js";
import type { ClaimLedger } from "./claims.js";

const stubClaims: ClaimLedger = {
  claims: [],
  unsupportedCount: 0,
  queue: () => {},
  settle: async () => {},
};

function ctxWithSources(
  docs: Array<{ id: string; url: string; title: string; markdown: string }>,
): ResearchCtx {
  const store = createSourceStore(stubClaims);
  for (const doc of docs) {
    const document = createSourceDocument(
      doc.url,
      doc.title,
      doc.markdown,
      { markdownChars: doc.markdown.length, extractionNotes: [] },
      doc.markdown.length,
      doc.id,
    );
    store.sourceDocuments.set(document.canonicalUrl, document);
    store.sourceDocumentsById.set(document.sourceId, document);
  }
  return { store } as unknown as ResearchCtx;
}

const CHILE = {
  id: "source_1",
  url: "https://example.com/chile",
  title: "Chile Water Report",
  markdown:
    "Chile freshwater usage is 15.5–32.8 m³/t according to the 2024 report.",
};

const RALEIGH = {
  id: "source_2",
  url: "https://example.com/raleigh",
  title: "Raleigh Housing",
  markdown: "Median Raleigh home prices ranged 425000 to 650000 in 2025.",
};

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe("execRunCode", () => {
  it("greps with provenance: source_id, url, offset, match, context", () => {
    const ctx = ctxWithSources([CHILE]);
    const out = parsed(
      execRunCode(
        { code: 'grep("[0-9.]+–[0-9.]+ m³/t", { context: 20 })' },
        ctx,
      ),
    );
    const matches = out.result as Array<Record<string, unknown>>;
    expect(out.sources_in_scope).toBe(1);
    expect(matches).toHaveLength(1);
    expect(matches[0].source_id).toBe("source_1");
    expect(matches[0].url).toBe(CHILE.url);
    expect(matches[0].match).toBe("15.5–32.8 m³/t");
    expect(matches[0].offset).toBe(CHILE.markdown.indexOf("15.5"));
    expect(String(matches[0].context)).toContain("usage is");
  });

  it("defaults to every stored source", () => {
    const ctx = ctxWithSources([CHILE, RALEIGH]);
    const out = parsed(execRunCode({ code: "sources.length" }, ctx));
    expect(out.sources_in_scope).toBe(2);
    expect(out.result).toBe(2);
  });

  it("filters scope with source_ids", () => {
    const ctx = ctxWithSources([CHILE, RALEIGH]);
    const out = parsed(
      execRunCode(
        { code: "sources[0].source_id", source_ids: ["source_2"] },
        ctx,
      ),
    );
    expect(out.sources_in_scope).toBe(1);
    expect(out.result).toBe("source_2");
  });

  it("computes over grep results and returns the final expression", () => {
    const ctx = ctxWithSources([CHILE, RALEIGH]);
    const out = parsed(
      execRunCode(
        { code: 'const m = grep("[0-9]+"); print("hits", m.length); m.length' },
        ctx,
      ),
    );
    expect(out.stdout).toContain("hits");
    expect(typeof out.result).toBe("number");
    expect(out.result as number).toBeGreaterThan(0);
  });

  it("caps runaway print output and marks truncation", () => {
    const ctx = ctxWithSources([CHILE]);
    const raw = execRunCode(
      { code: 'for (let i = 0; i < 5000; i++) print("x".repeat(50)); "done"' },
      ctx,
    );
    const out = parsed(raw);
    expect(raw.length).toBeLessThanOrEqual(8_400);
    expect(out.truncated).toBe(true);
    expect(String(out.stdout)).toContain("... [output truncated]");
  });

  it("terminates runaway loops via timeout", () => {
    const ctx = ctxWithSources([CHILE]);
    const started = Date.now();
    const out = parsed(
      execRunCode({ code: "while (true) {}", timeout_ms: 50 }, ctx),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.error).toBe("code timed out after 50ms");
  });

  it("surfaces script throws and keeps captured stdout", () => {
    const ctx = ctxWithSources([CHILE]);
    const out = parsed(
      execRunCode({ code: 'print("before"); throw new Error("boom");' }, ctx),
    );
    expect(out.error).toBe("code threw: boom");
    expect(out.stdout).toBe("before");
    expect(out.sources_in_scope).toBe(1);
  });

  it("reports invalid grep regexes", () => {
    const ctx = ctxWithSources([CHILE]);
    const out = parsed(execRunCode({ code: 'grep("[")' }, ctx));
    expect(String(out.error)).toMatch(/invalid regex/);
  });

  it("errors when no sources are stored", () => {
    const ctx = ctxWithSources([]);
    expect(execRunCode({ code: "1" }, ctx)).toBe(
      "Error: no fetched source documents are available to run code over.",
    );
  });

  it("errors on empty code", () => {
    const ctx = ctxWithSources([CHILE]);
    const expected = "Error: run_code requires non-empty `code`.";
    expect(execRunCode({ code: "" }, ctx)).toBe(expected);
    expect(execRunCode({ code: "   " }, ctx)).toBe(expected);
  });

  it("errors on unknown source_id", () => {
    const ctx = ctxWithSources([CHILE]);
    expect(execRunCode({ code: "1", source_ids: ["source_99"] }, ctx)).toBe(
      "Error: unknown source_id: source_99",
    );
  });

  it("exposes no node or network globals", () => {
    const ctx = ctxWithSources([CHILE]);
    const out = parsed(
      execRunCode(
        {
          code: 'typeof require + "," + typeof process + "," + typeof fetch + "," + typeof setTimeout',
        },
        ctx,
      ),
    );
    expect(out.result).toBe("undefined,undefined,undefined,undefined");
  });

  it("serializes printed values", () => {
    const ctx = ctxWithSources([CHILE]);
    const out = parsed(
      execRunCode({ code: 'print({ a: 1 }); print(1, 2); "ok"' }, ctx),
    );
    expect(out.stdout).toBe('{"a":1}\n1 2');
    expect(out.result).toBe("ok");
  });
});
