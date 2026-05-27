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

    expect(audit.verifiedSources).toEqual([
      {
        url: "https://example.com/report?a=1&b=2",
        title: "Example Report",
      },
    ]);
    expect(audit.unverifiedCitations).toEqual([]);
  });

  it("does not promote unfetched cited URLs into verified sources", () => {
    const audit = __testing.auditCitationsInMarkdown(
      [
        "Verified evidence from [Fetched](https://example.com/fetched).",
        "Unverified claim from [Unfetched](https://example.com/unfetched).",
        "Repeated bare URL should dedupe: https://example.com/unfetched.",
      ].join("\n"),
      [
        {
          url: "https://example.com/fetched",
          title: "Fetched Source",
        },
      ],
    );

    expect(audit.verifiedSources).toEqual([
      {
        url: "https://example.com/fetched",
        title: "Fetched Source",
      },
    ]);
    expect(audit.unverifiedCitations).toEqual([
      "https://example.com/unfetched",
    ]);
  });
});
