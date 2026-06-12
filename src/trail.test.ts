import { describe, expect, it } from "vitest";
import { createTrail, trailCapsFor } from "./trail.js";

describe("trailCapsFor", () => {
  it("scales caps with the source budget", () => {
    expect(trailCapsFor(250)).toEqual({ maxSearches: 250, maxDeadEnds: 125 });
    expect(trailCapsFor(250, 0.5)).toEqual({
      maxSearches: 125,
      maxDeadEnds: 63,
    });
  });

  it("floors caps for small source budgets", () => {
    expect(trailCapsFor(15)).toEqual({ maxSearches: 30, maxDeadEnds: 15 });
    expect(trailCapsFor(40, 0.25)).toEqual({
      maxSearches: 30,
      maxDeadEnds: 15,
    });
  });
});

describe("createTrail", () => {
  it("renders nothing when empty", () => {
    expect(createTrail().render()).toBe("");
  });

  it("records searches with result counts", () => {
    const trail = createTrail();
    trail.recordSearch("steel browser funding", 8);
    trail.recordSearch("steel browser series a", 0);
    const rendered = trail.render();
    expect(rendered).toContain("Searches already run (2");
    expect(rendered).toContain('- "steel browser funding" → 8 result(s)');
    expect(rendered).toContain('- "steel browser series a" → 0 result(s)');
  });

  it("dedupes searches case-insensitively and keeps the best result count", () => {
    const trail = createTrail();
    trail.recordSearch("Steel Browser", 0);
    trail.recordSearch("steel browser", 5);
    trail.recordSearch("steel browser", 2);
    expect(trail.searchCount).toBe(1);
    expect(trail.render()).toContain('- "Steel Browser" → 5 result(s)');
  });

  it("ignores empty queries and urls", () => {
    const trail = createTrail();
    trail.recordSearch("  ", 3);
    trail.recordDeadEnd("", "reason");
    expect(trail.searchCount).toBe(0);
    expect(trail.deadEndCount).toBe(0);
  });

  it("records dead ends once per url and truncates long reasons", () => {
    const trail = createTrail();
    trail.recordDeadEnd("https://a.example.com/x", "blocked_or_challenge");
    trail.recordDeadEnd("https://a.example.com/x", "other reason");
    trail.recordDeadEnd("https://b.example.com/y", "e".repeat(500));
    expect(trail.deadEndCount).toBe(2);
    const rendered = trail.render();
    expect(rendered).toContain(
      "- https://a.example.com/x — blocked_or_challenge",
    );
    expect(rendered).toContain(`- https://b.example.com/y — ${"e".repeat(120)}`);
    expect(rendered).not.toContain("e".repeat(121));
  });

  it("caps rendered entries and reports the overflow", () => {
    const trail = createTrail();
    for (let i = 0; i < 7; i++) trail.recordSearch(`query ${i}`, i);
    for (let i = 0; i < 5; i++) {
      trail.recordDeadEnd(`https://example.com/${i}`, "thin_content");
    }
    const rendered = trail.render({ maxSearches: 4, maxDeadEnds: 3 });
    expect(rendered).toContain("…and 3 more searches");
    expect(rendered).toContain("…and 2 more dead ends");
    expect(rendered).toContain('- "query 3"');
    expect(rendered).not.toContain('- "query 4"');
  });
});
