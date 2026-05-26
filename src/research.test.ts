import { describe, expect, it } from "vitest";
import { __testing } from "./research.js";

describe("research source citations", () => {
  it("matches cited URLs with the same normalization used for fetched sources", () => {
    const audit = __testing.auditCitationsInMarkdown(
      "Evidence from [Example](https://example.com/report?utm_source=newsletter&b=2&a=1#section).",
      [
        {
          url: "https://example.com/report?a=1&b=2",
          title: "Example Report",
        },
      ],
    );

    expect(audit.sources).toEqual([
      {
        url: "https://example.com/report?a=1&b=2",
        title: "Example Report",
      },
    ]);
    expect(audit.unverified_citations).toEqual([]);
  });

  it("does not promote unopened cited URLs into verified sources", () => {
    const audit = __testing.auditCitationsInMarkdown(
      [
        "Verified evidence from [Opened](https://example.com/opened).",
        "Unverified claim from [Unopened](https://example.com/unopened).",
        "Repeated bare URL should dedupe: https://example.com/unopened.",
      ].join("\n"),
      [
        {
          url: "https://example.com/opened",
          title: "Opened Source",
        },
      ],
    );

    expect(audit.sources).toEqual([
      {
        url: "https://example.com/opened",
        title: "Opened Source",
      },
    ]);
    expect(audit.unverified_citations).toEqual([
      "https://example.com/unopened",
    ]);
  });
});
