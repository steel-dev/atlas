import { describe, expect, it } from "vitest";
import {
  addSlot,
  applyCoverageUpdate,
  centralFactsAllFilled,
  findSlot,
  isAnswered,
  type Ledger,
  openItems,
  renderDeliverableContract,
  renderGatherContract,
  renderLedgerAudit,
  stripGuessedValues,
} from "./checklist.js";

function fixture(): Ledger {
  return {
    nextId: 3,
    scope: "broad",
    slots: [
      {
        id: "slot_1",
        ask: "Q1 2026 revenue figure",
        shape: "value",
        kind: "fact",
        importance: "central",
        fill: null,
      },
      {
        id: "slot_2",
        ask: "definition of the metric",
        shape: "value",
        kind: "fact",
        importance: "central",
        fill: null,
      },
    ],
  };
}

describe("stripGuessedValues", () => {
  it("removes money, percentages, ranges, and decimals but keeps bare years", () => {
    expect(stripGuessedValues("operating margin (~6%) for FY2024")).toBe(
      "operating margin for FY2024",
    );
    expect(stripGuessedValues("revenue of $176.6M in 2025")).toContain("2025");
    expect(stripGuessedValues("revenue of $176.6M in 2025")).not.toContain(
      "176",
    );
    expect(stripGuessedValues("a churn band of 5-10%")).not.toMatch(/\d/);
  });
});

describe("applyCoverageUpdate", () => {
  it("marks open slots stated by id and ignores unknown ids", () => {
    const ledger = fixture();
    applyCoverageUpdate(ledger, {
      closedIds: ["slot_1", "slot_99"],
      newItems: [],
    });
    expect(ledger.slots[0].fill).toEqual({ kind: "stated" });
    expect(ledger.slots[1].fill).toBeNull();
  });

  it("appends new slots with fresh ids and skips duplicate asks", () => {
    const ledger = fixture();
    applyCoverageUpdate(ledger, {
      closedIds: [],
      newItems: [
        {
          ask: "competitor pricing",
          shape: "value",
          kind: "fact",
          importance: "peripheral",
        },
        {
          ask: "Q1 2026 revenue figure",
          shape: "value",
          kind: "fact",
          importance: "central",
        },
      ],
    });
    expect(ledger.slots).toHaveLength(3);
    expect(ledger.slots[2]).toMatchObject({
      id: "slot_3",
      ask: "competitor pricing",
      fill: null,
    });
    expect(ledger.nextId).toBe(4);
  });

  it("never overwrites an already-filled slot", () => {
    const ledger = fixture();
    ledger.slots[0].fill = {
      kind: "grounded",
      value: "$10M",
      quote: "revenue was 10",
      source: "source_1",
    };
    applyCoverageUpdate(ledger, { closedIds: ["slot_1"], newItems: [] });
    expect(ledger.slots[0].fill).toMatchObject({ kind: "grounded" });
  });

  it("marks exhausted ids", () => {
    const ledger = fixture();
    applyCoverageUpdate(ledger, {
      closedIds: [],
      exhaustedIds: ["slot_2"],
      newItems: [],
    });
    expect(ledger.slots[1].fill).toMatchObject({ kind: "exhausted" });
  });
});

describe("addSlot / findSlot", () => {
  it("adds a slot with a fresh id and finds it", () => {
    const ledger = fixture();
    const slot = addSlot(ledger, {
      ask: "headline CAC for FY2024",
      shape: "value",
      kind: "fact",
      importance: "central",
    });
    expect(slot.id).toBe("slot_3");
    expect(findSlot(ledger, "slot_3")).toBe(slot);
    expect(findSlot(ledger, "missing")).toBeUndefined();
  });
});

describe("isAnswered / centralFactsAllFilled", () => {
  it("is false while a central fact is open", () => {
    expect(isAnswered(fixture())).toBe(false);
    expect(centralFactsAllFilled(fixture())).toBe(false);
  });

  it("centralFactsAllFilled is true once every central fact is filled", () => {
    const ledger = fixture();
    for (const slot of ledger.slots) {
      slot.fill = {
        kind: "grounded",
        value: "x",
        quote: "supporting quote text",
        source: "source_1",
      };
    }
    expect(centralFactsAllFilled(ledger)).toBe(true);
    expect(isAnswered(ledger)).toBe(true);
  });

  it("an exhausted central fact does not count as filled for the gather stop", () => {
    const ledger = fixture();
    ledger.slots[0].fill = {
      kind: "grounded",
      value: "x",
      quote: "supporting quote text",
      source: "source_1",
    };
    ledger.slots[1].fill = { kind: "exhausted", reason: "dead end" };
    expect(centralFactsAllFilled(ledger)).toBe(false);
    expect(isAnswered(ledger)).toBe(true);
  });

  it("does not block on an open central analysis slot", () => {
    const ledger: Ledger = {
      nextId: 2,
      scope: "broad",
      slots: [
        {
          id: "slot_1",
          ask: "compare how each tradition structures reform",
          shape: "matrix",
          kind: "analysis",
          importance: "central",
          fill: null,
        },
      ],
    };
    expect(isAnswered(ledger)).toBe(true);
    expect(centralFactsAllFilled(ledger)).toBe(false);
  });
});

describe("rendering", () => {
  it("gather contract carries slot ids, importance, and shape", () => {
    const contract = renderGatherContract(fixture());
    expect(contract).toContain(
      "[slot_1 · central · value] Q1 2026 revenue figure",
    );
  });

  it("audit shows status and the closed value", () => {
    const ledger = fixture();
    ledger.slots[0].fill = {
      kind: "grounded",
      value: "$12.4M",
      quote: "Q1 revenue reached 12.4 million",
      source: "source_3",
    };
    const audit = renderLedgerAudit(ledger);
    expect(audit).toContain("[slot_1·central·value·filled]");
    expect(audit).toContain("$12.4M [source_3]");
    expect(audit).toContain("[slot_2·central·value·open]");
  });

  it("deliverable contract lists only filled slots with their values and a shape legend", () => {
    const ledger = fixture();
    ledger.slots[0].fill = {
      kind: "grounded",
      value: "$12.4M",
      quote: "Q1 revenue reached 12.4 million",
      source: "source_3",
    };
    const contract = renderDeliverableContract(ledger);
    expect(contract).toContain("$12.4M [source_3]");
    expect(contract).toContain("value: state the figure");
    expect(contract).not.toContain("definition of the metric");
  });

  it("deliverable contract is empty when nothing is filled", () => {
    expect(renderDeliverableContract(fixture())).toBe("");
  });

  it("openItems returns only open slots", () => {
    const ledger = fixture();
    ledger.slots[0].fill = { kind: "stated" };
    expect(openItems(ledger).map((slot) => slot.id)).toEqual(["slot_2"]);
  });
});
