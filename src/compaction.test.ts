import { describe, expect, it } from "vitest";
import type { ModelMessage } from "./model.js";
import type { ResearchCtx } from "./runtime.js";
import { __testing, estimateMessagesTokens } from "./compaction.js";

const { planCutIndex, buildSourceIndex } = __testing;

function question(chars: number): ModelMessage {
  return { role: "user", content: "q".repeat(chars) };
}

function assistantText(chars: number, marker = "a"): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: marker.repeat(chars) }],
  };
}

function toolResult(id: string, chars: number): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_call_id: id, content: "r".repeat(chars) },
    ],
  };
}

describe("estimateMessagesTokens", () => {
  it("approximates tokens from content length", () => {
    expect(estimateMessagesTokens([question(4)])).toBe(1);
    expect(estimateMessagesTokens([question(40)])).toBe(10);
    expect(
      estimateMessagesTokens([assistantText(400), toolResult("t1", 400)]),
    ).toBe(200);
  });
});

describe("planCutIndex", () => {
  // [Q, A1, U1, A2, U2, A3, U3] — 10t question, then 100t turns.
  const transcript: ModelMessage[] = [
    question(40),
    assistantText(400, "A"),
    toolResult("t1", 400),
    assistantText(400, "B"),
    toolResult("t2", 400),
    assistantText(400, "C"),
    toolResult("t3", 400),
  ];

  it("keeps only the final turn when the keep budget is small", () => {
    expect(planCutIndex(transcript, 50)).toBe(5);
    expect(planCutIndex(transcript, 250)).toBe(5);
  });

  it("folds nothing when everything fits in the keep budget", () => {
    expect(planCutIndex(transcript, 100_000)).toBe(1);
  });

  it("always returns an assistant-aligned boundary", () => {
    for (const keep of [10, 50, 150, 250, 350, 500, 100_000]) {
      const cut = planCutIndex(transcript, keep);
      if (cut >= 1 && cut < transcript.length) {
        expect(transcript[cut].role).toBe("assistant");
      }
    }
  });

  it("snaps a boundary that lands on a tool_result down to its assistant turn", () => {
    // keep≈350 would naturally stop on U2 (index 4); it must snap to A2 (3).
    expect(planCutIndex(transcript, 350)).toBe(3);
  });
});

describe("buildSourceIndex", () => {
  it("lists fetched sources with their handles and dedupes", () => {
    const ctx = {
      store: {
        fetchedSources: [
          { url: "https://a.example", title: "A", sourceId: "source_1" },
          { url: "https://b.example", title: "B", sourceId: "source_2" },
          { url: "https://a.example", title: "A", sourceId: "source_1" },
        ],
      },
    } as unknown as ResearchCtx;
    const index = buildSourceIndex(ctx);

    expect(index).toContain("source_1 — A (https://a.example)");
    expect(index).toContain("source_2 — B (https://b.example)");
    expect(index.match(/source_1/g)?.length).toBe(1);
  });

  it("returns an empty string when nothing has been fetched", () => {
    const ctx = {
      store: { fetchedSources: [] },
    } as unknown as ResearchCtx;
    expect(buildSourceIndex(ctx)).toBe("");
  });
});
