import { describe, expect, it } from "vitest";
import { envelopeFail, envelopeOk } from "./envelope";

describe("envelope", () => {
  it("envelopeOk returns success shape", () => {
    expect(envelopeOk({ name: "atlas" }, "req_123")).toEqual({
      success: true,
      data: { name: "atlas" },
      request_id: "req_123",
    });
  });

  it("envelopeFail returns failure shape", () => {
    expect(envelopeFail("E_VALIDATION", "bad input", "req_456")).toEqual({
      success: false,
      code: "E_VALIDATION",
      error: "bad input",
      request_id: "req_456",
    });
  });
});
