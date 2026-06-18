import { describe, expect, it } from "vitest";
import {
  applyCoverageUpdate,
  isAnswered,
  openItems,
  renderChecklistAudit,
  renderChecklistContract,
  type Checklist,
} from "./checklist.js";

function fixture(): Checklist {
  return {
    nextId: 3,
    items: [
      {
        id: "item_1",
        fact: "Q1 2026 revenue figure",
        importance: "central",
        volatility: "volatile",
        status: "open",
      },
      {
        id: "item_2",
        fact: "definition of the metric",
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
        { fact: "competitor pricing", importance: "peripheral", volatility: "volatile" },
        { fact: "Q1 2026 revenue figure", importance: "central", volatility: "volatile" },
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
  it("is false while a central volatile item is open", () => {
    expect(isAnswered(fixture())).toBe(false);
  });

  it("is true once every central volatile item is closed", () => {
    const checklist = fixture();
    applyCoverageUpdate(checklist, { closedIds: ["item_1"], newItems: [] });
    expect(isAnswered(checklist)).toBe(true);
  });

  it("does not block on an open central stable item", () => {
    const checklist: Checklist = {
      nextId: 2,
      items: [
        {
          id: "item_1",
          fact: "settled definition",
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
});
