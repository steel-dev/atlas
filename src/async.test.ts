import { describe, expect, it } from "vitest";
import { withTimeout } from "./async.js";

describe("withTimeout", () => {
  it("resolves when the task finishes in time", async () => {
    const value = await withTimeout(1_000, undefined, "task", async () => 42);
    expect(value).toBe(42);
  });

  it("rejects with a labeled error when the task exceeds the timeout", async () => {
    await expect(
      withTimeout(
        20,
        undefined,
        "slow_tool",
        () => new Promise((resolve) => setTimeout(resolve, 1_000)),
      ),
    ).rejects.toThrow(/slow_tool timed out/);
  });

  it("aborts the inner signal on timeout", async () => {
    let aborted = false;
    await withTimeout(
      20,
      undefined,
      "task",
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(null);
          });
        }),
    ).catch(() => {});
    expect(aborted).toBe(true);
  });

  it("propagates parent aborts", async () => {
    const controller = new AbortController();
    const pending = withTimeout(
      10_000,
      controller.signal,
      "task",
      () => new Promise(() => {}),
    );
    controller.abort(new Error("parent aborted"));
    await expect(pending).rejects.toThrow("parent aborted");
  });
});
