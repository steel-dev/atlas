export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal?.throwIfAborted();
    return;
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

class Semaphore implements ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) =>
      this.waiting.push(() => {
        this.active++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const normalized = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
  return new Semaphore(normalized);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(normalizedLimit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
