import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileStore,
  JournalWriter,
  loadReplayCache,
  loadRunMeta,
  memoryStore,
  ReplayCache,
  type RunStore,
} from "./store.js";

async function collect(store: RunStore, runId: string) {
  const entries = [];
  for await (const entry of store.read(runId)) entries.push(entry);
  return entries;
}

describe("memoryStore", () => {
  it("appends and reads entries in order", async () => {
    const store = memoryStore();
    await store.append("run_1", [
      { seq: 0, kind: "meta", data: { question: "q" } },
      { seq: 1, kind: "event", type: "run.started", data: {} },
    ]);
    const entries = await collect(store, "run_1");
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("meta");
  });
});

describe("fileStore", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips journal entries as JSONL", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-store-"));
    const store = fileStore(dir);
    await store.append("run_abc", [
      { seq: 0, kind: "meta", data: { question: "what?" } },
      { seq: 1, kind: "call", callKey: "k1", data: { content: [] } },
    ]);
    const entries = await collect(store, "run_abc");
    expect(entries).toHaveLength(2);
    expect(entries[1].callKey).toBe("k1");
    const meta = await loadRunMeta(store, "run_abc");
    expect(meta?.question).toBe("what?");
  });

  it("reads nothing for unknown runs", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-store-"));
    const store = fileStore(dir);
    expect(await collect(store, "missing")).toHaveLength(0);
  });
});

describe("JournalWriter and ReplayCache", () => {
  it("flushes buffered entries and replays calls FIFO per key", async () => {
    const store = memoryStore();
    const writer = new JournalWriter(store, "run_x");
    writer.meta({ question: "q" });
    writer.call("key_a", { value: 1 });
    writer.call("key_a", { value: 2 });
    writer.call("key_b", { value: 3 });
    await writer.flush();

    const cache = await loadReplayCache(store, "run_x");
    expect(cache.size).toBe(3);
    expect(cache.take("key_a")).toEqual({ value: 1 });
    expect(cache.take("key_a")).toEqual({ value: 2 });
    expect(cache.take("key_a")).toBeUndefined();
    expect(cache.take("key_b")).toEqual({ value: 3 });
    expect(cache.replayedCalls).toBe(3);
  });

  it("returns undefined for unknown keys", () => {
    const cache = new ReplayCache();
    expect(cache.take("nope")).toBeUndefined();
  });
});
