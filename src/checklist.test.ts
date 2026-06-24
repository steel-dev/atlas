import { describe, expect, it } from "vitest";
import {
  applyCoverageUpdate,
  isAnswered,
  openItems,
  renderAnalyticalDemands,
  renderChecklistAudit,
  renderChecklistContract,
  type Checklist,
} from "./checklist.js";

function fixture(): Checklist {
  return {
    nextId: 3,
    scope: "broad",
    items: [
      {
        id: "item_1",
        fact: "Q1 2026 revenue figure",
        kind: "fact",
        importance: "central",
        volatility: "volatile",
        status: "open",
      },
      {
        id: "item_2",
        fact: "definition of the metric",
        kind: "fact",
        importance: "central",
        volatility: "stable",
        status: "open",
      },
    ],
  };
}

describe("applyCoverageUpdate", () => {
  it("closes open items by id and ignores unknown ids", () => {
    const checklist = fixture();
    applyCoverageUpdate(checklist, {
      closedIds: ["item_1", "item_99"],
      newItems: [],
    });
    expect(checklist.items[0].status).toBe("grounded");
    expect(checklist.items[1].status).toBe("open");
  });

  it("appends new items with fresh ids and skips duplicates", () => {
    const checklist = fixture();
    applyCoverageUpdate(checklist, {
      closedIds: [],
      newItems: [
        { fact: "competitor pricing", kind: "fact", importance: "peripheral", volatility: "volatile" },
        { fact: "Q1 2026 revenue figure", kind: "fact", importance: "central", volatility: "volatile" },
      ],
    });
    expect(checklist.items).toHaveLength(3);
    expect(checklist.items[2]).toMatchObject({
      id: "item_3",
      fact: "competitor pricing",
      status: "open",
    });
    expect(checklist.nextId).toBe(4);
  });

  it("never reopens an already-grounded item", () => {
    const checklist = fixture();
    checklist.items[0].status = "grounded";
    applyCoverageUpdate(checklist, { closedIds: [], newItems: [] });
    expect(checklist.items[0].status).toBe("grounded");
  });
});

describe("isAnswered", () => {
  it("is false while any central item is open", () => {
    expect(isAnswered(fixture())).toBe(false);
  });

  it("is true once every central item is closed", () => {
    const checklist = fixture();
    applyCoverageUpdate(checklist, {
      closedIds: ["item_1", "item_2"],
      newItems: [],
    });
    expect(isAnswered(checklist)).toBe(true);
  });

  it("blocks on an open central stable fact", () => {
    const checklist: Checklist = {
      nextId: 2,
      scope: "broad",
      items: [
        {
          id: "item_1",
          fact: "settled definition",
          kind: "fact",
          importance: "central",
          volatility: "stable",
          status: "open",
        },
      ],
    };
    expect(isAnswered(checklist)).toBe(false);
  });

  it("does not block on an open peripheral item", () => {
    const checklist: Checklist = {
      nextId: 2,
      scope: "broad",
      items: [
        {
          id: "item_1",
          fact: "useful context",
          kind: "fact",
          importance: "peripheral",
          volatility: "volatile",
          status: "open",
        },
      ],
    };
    expect(isAnswered(checklist)).toBe(true);
  });

  it("does not block on an open central analysis item", () => {
    const checklist: Checklist = {
      nextId: 2,
      scope: "broad",
      items: [
        {
          id: "item_1",
          fact: "compare how each tradition structures reform",
          kind: "analysis",
          importance: "central",
          volatility: "stable",
          status: "open",
        },
      ],
    };
    expect(isAnswered(checklist)).toBe(true);
  });
});

describe("rendering", () => {
  it("contract omits ids and status; audit includes them", () => {
    const checklist = fixture();
    const contract = renderChecklistContract(checklist);
    expect(contract).toContain("[central·volatile] Q1 2026 revenue figure");
    expect(contract).not.toContain("item_1");

    const audit = renderChecklistAudit(checklist);
    expect(audit).toContain("[item_1·central·volatile·open]");
  });

  it("openItems returns only open items", () => {
    const checklist = fixture();
    checklist.items[0].status = "grounded";
    expect(openItems(checklist).map((item) => item.id)).toEqual(["item_2"]);
  });

  it("contract lists facts only; analytical demands list analysis items only", () => {
    const checklist: Checklist = {
      nextId: 3,
      scope: "broad",
      items: [
        {
          id: "item_1",
          fact: "the 1950 Marriage Law abolished arranged marriage",
          kind: "fact",
          importance: "central",
          volatility: "stable",
          status: "open",
        },
        {
          id: "item_2",
          fact: "compare reform authority across secular and religious traditions",
          kind: "analysis",
          importance: "central",
          volatility: "stable",
          status: "open",
        },
      ],
    };
    const contract = renderChecklistContract(checklist);
    expect(contract).toContain("1950 Marriage Law");
    expect(contract).not.toContain("compare reform authority");

    const demands = renderAnalyticalDemands(checklist);
    expect(demands).toContain("compare reform authority");
    expect(demands).not.toContain("1950 Marriage Law");
  });
});
