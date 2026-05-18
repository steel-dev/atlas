import { describe, expect, it } from "vitest";
import { deriveJobIdFromKey, parseIdempotencyHeader, sha256Hex } from "./idempotency";

describe("parseIdempotencyHeader", () => {
  it("returns null key when header absent", () => {
    const r = parseIdempotencyHeader(undefined);
    expect(r).toEqual({ ok: true, key: null });
  });

  it("accepts a normal key", () => {
    const r = parseIdempotencyHeader("order-42_abc");
    expect(r).toEqual({ ok: true, key: "order-42_abc" });
  });

  it("trims surrounding whitespace", () => {
    const r = parseIdempotencyHeader("  k1  ");
    expect(r).toEqual({ ok: true, key: "k1" });
  });

  it("rejects empty after trim", () => {
    const r = parseIdempotencyHeader("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects > 255 chars", () => {
    const r = parseIdempotencyHeader("x".repeat(256));
    expect(r.ok).toBe(false);
  });

  it("rejects non-printable ASCII", () => {
    const r = parseIdempotencyHeader("bad\nkey");
    expect(r.ok).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("is deterministic", async () => {
    const a = await sha256Hex("hello");
    const b = await sha256Hex("hello");
    expect(a).toBe(b);
  });

  it("differs across distinct inputs", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });

  it("returns 64 hex chars", async () => {
    const h = await sha256Hex("x");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveJobIdFromKey", () => {
  it("is deterministic for the same key", async () => {
    expect(await deriveJobIdFromKey("k1")).toBe(await deriveJobIdFromKey("k1"));
  });

  it("differs across keys", async () => {
    expect(await deriveJobIdFromKey("k1")).not.toBe(await deriveJobIdFromKey("k2"));
  });

  it("starts with idem_ prefix and is 30 chars total", async () => {
    const id = await deriveJobIdFromKey("anything");
    expect(id).toMatch(/^idem_[0-9a-f]{25}$/);
  });
});
