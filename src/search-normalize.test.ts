import { describe, expect, it } from "vitest";
import { canonicalQuery, trailKey } from "./search-normalize.js";

describe("canonicalQuery", () => {
  it("collapses case, whitespace, punctuation, order, and duplicates", () => {
    expect(canonicalQuery("Cold Start  Lambda")).toBe(
      canonicalQuery("lambda cold start"),
    );
    expect(canonicalQuery("AWS, Lambda! Lambda")).toBe("aws lambda");
  });

  it("keeps year tokens because recency changes cache intent", () => {
    expect(canonicalQuery("lambda pricing 2025")).not.toBe(
      canonicalQuery("lambda pricing"),
    );
  });
});

describe("trailKey", () => {
  it("collapses bare-year variants so the advisory list catches them", () => {
    expect(trailKey("cloudflare cpu limit free paid plan")).toBe(
      trailKey("cloudflare cpu limit free paid plan 2024 2025"),
    );
  });

  it("falls back to the raw query when only years are present", () => {
    expect(trailKey("2024 2025")).toBe("2024 2025");
  });
});
