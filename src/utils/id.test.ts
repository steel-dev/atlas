import { describe, expect, it } from "vitest";
import { newJobId, newRequestId } from "./id";

describe("ID generators", () => {
  it("newJobId returns a lowercase 26-char ULID", () => {
    expect(newJobId()).toMatch(/^[0-9a-z]{26}$/);
  });

  it("newJobId produces unique IDs across calls", () => {
    const a = newJobId();
    const b = newJobId();
    expect(a).not.toBe(b);
  });

  it("newRequestId is prefixed with 'req_'", () => {
    expect(newRequestId()).toMatch(/^req_[0-9a-z]{26}$/);
  });
});
