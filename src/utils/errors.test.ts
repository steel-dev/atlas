import { describe, expect, it } from "vitest";
import { ErrorCodes } from "./errors";

describe("ErrorCodes taxonomy", () => {
  const required = [
    "E_BAD_REQUEST",
    "E_VALIDATION",
    "E_NOT_FOUND",
    "E_UNAUTHORIZED",
    "E_RATE_LIMIT",
    "E_IDEMPOTENCY_CONFLICT",
    "E_JOB_NOT_FOUND",
    "E_JOB_CANCELLED",
    "E_INTERNAL",
    "E_NOT_IMPLEMENTED",
    "E_STEEL_TIMEOUT",
    "E_STEEL_UNAVAILABLE",
    "E_LLM_QUOTA",
    "E_LLM_TIMEOUT",
  ] as const;

  it.each(required)("defines %s with matching key/value", (code) => {
    expect(ErrorCodes).toHaveProperty(code, code);
  });
});
