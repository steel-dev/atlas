import { describe, expect, it } from "vitest";
import { __testing } from "./research.js";

describe("research source citations", () => {
  it("matches cited URLs with the same normalization used for fetched sources", () => {
    const sources = __testing.sourcesCitedInMarkdown(
      "Evidence from [Example](https://example.com/report?utm_source=newsletter&b=2&a=1#section).",
      [
        {
          url: "https://example.com/report?a=1&b=2",
          title: "Example Report",
        },
      ],
    );

    expect(sources).toEqual([
      {
        url: "https://example.com/report?a=1&b=2",
        title: "Example Report",
      },
    ]);
  });
});
