import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface JournalEntry {
  seq: number;
  kind: "meta" | "event" | "call" | "io";
  type?: string;
  callKey?: string;
  data: unknown;
}

export interface RunSummary {
  runId: string;
  question?: string;
  status?: string;
}

export interface RunStore {
  append(runId: string, entries: JournalEntry[]): Promise<void>;
  read(runId: string): AsyncIterable<JournalEntry>;
  list(): AsyncIterable<RunSummary>;
}

export function memoryStore(): RunStore {
  const runs = new Map<string, JournalEntry[]>();
  return {
    async append(runId, entries) {
      const existing = runs.get(runId) ?? [];
      existing.push(...entries);
      runs.set(runId, existing);
    },
    async *read(runId) {
      for (const entry of runs.get(runId) ?? []) yield entry;
    },
    async *list() {
      for (const [runId, entries] of runs) {
        yield summarize(runId, entries);
      }
    },
  };
}

export function fileStore(dir: string): RunStore {
  const fileFor = (runId: string) =>
    join(dir, `${runId.replace(/[^\w.-]/g, "_")}.jsonl`);
  return {
    async append(runId, entries) {
      if (entries.length === 0) return;
      await mkdir(dir, { recursive: true });
      const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
      await appendFile(fileFor(runId), `${lines}\n`, "utf8");
    },
    async *read(runId) {
      let raw: string;
      try {
        raw = await readFile(fileFor(runId), "utf8");
      } catch {
        return;
      }
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as JournalEntry;
        } catch {
          continue;
        }
      }
    },
    async *list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        yield { runId: name.slice(0, -".jsonl".length) };
      }
    },
  };
}

function summarize(runId: string, entries: JournalEntry[]): RunSummary {
  const meta = entries.find((entry) => entry.kind === "meta");
  const metaData = (meta?.data ?? {}) as { question?: string };
  const last = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.kind === "event" &&
        (entry.type === "run.completed" || entry.type === "run.error"),
    );
  return {
    runId,
    ...(metaData.question ? { question: metaData.question } : {}),
    status: last
      ? last.type === "run.completed"
        ? "completed"
        : "failed"
      : "incomplete",
  };
}

export class JournalWriter {
  private seq = 0;
  private pending: JournalEntry[] = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    private readonly runId: string,
  ) {}

  meta(data: unknown): void {
    this.push({ seq: this.seq++, kind: "meta", data });
  }

  event(type: string, data: unknown): void {
    this.push({ seq: this.seq++, kind: "event", type, data });
  }

  call(callKey: string, data: unknown): void {
    this.push({ seq: this.seq++, kind: "call", callKey, data });
  }

  io(callKey: string, data: unknown): void {
    this.push({ seq: this.seq++, kind: "io", callKey, data });
  }

  private push(entry: JournalEntry): void {
    this.pending.push(entry);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.flushing = this.flushing.then(async () => {
      if (this.pending.length === 0) return;
      const batch = this.pending;
      this.pending = [];
      try {
        await this.store.append(this.runId, batch);
      } catch {
        return;
      }
    });
  }

  async flush(): Promise<void> {
    await this.flushing;
    if (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      try {
        await this.store.append(this.runId, batch);
      } catch {
        return;
      }
    }
  }
}

export class ReplayCache {
  private readonly byKey = new Map<string, unknown[]>();
  private hits = 0;

  add(callKey: string, data: unknown): void {
    const queue = this.byKey.get(callKey) ?? [];
    queue.push(data);
    this.byKey.set(callKey, queue);
  }

  take(callKey: string): unknown | undefined {
    const queue = this.byKey.get(callKey);
    if (!queue || queue.length === 0) return undefined;
    this.hits++;
    return queue.shift();
  }

  values(prefix: string): unknown[] {
    const found: unknown[] = [];
    for (const [key, queue] of this.byKey) {
      if (key.startsWith(prefix)) found.push(...queue);
    }
    return found;
  }

  get replayedCalls(): number {
    return this.hits;
  }

  get size(): number {
    let total = 0;
    for (const queue of this.byKey.values()) total += queue.length;
    return total;
  }
}

export async function loadReplayCache(
  store: RunStore,
  runId: string,
): Promise<ReplayCache> {
  const cache = new ReplayCache();
  for await (const entry of store.read(runId)) {
    if ((entry.kind === "call" || entry.kind === "io") && entry.callKey) {
      cache.add(entry.callKey, entry.data);
    }
  }
  return cache;
}

export async function loadRunMeta(
  store: RunStore,
  runId: string,
): Promise<Record<string, unknown> | null> {
  for await (const entry of store.read(runId)) {
    if (entry.kind === "meta") {
      return (entry.data ?? {}) as Record<string, unknown>;
    }
  }
  return null;
}
