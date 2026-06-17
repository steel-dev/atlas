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

export async function withTimeout<T>(
  ms: number,
  parentSignal: AbortSignal | undefined,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  const combined = parentSignal
    ? AbortSignal.any([parentSignal, timeout])
    : timeout;
  return await Promise.race([
    fn(combined),
    new Promise<never>((_, reject) => {
      const onAbort = (): void =>
        reject(
          timeout.aborted && !parentSignal?.aborted
            ? new Error(
                `${label} timed out after ${Math.round(ms / 1000)}s`,
              )
            : (combined.reason ?? new Error("Aborted")),
        );
      if (combined.aborted) onAbort();
      else combined.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
}

export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  acquire(): Promise<() => void>;
}

class Semaphore implements ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async acquire(): Promise<() => void> {
    await this.acquireSlot();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private async acquireSlot(): Promise<void> {
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

  private releaseSlot(): void {
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

class DynamicSemaphore implements ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limitFn: () => number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async acquire(): Promise<() => void> {
    await this.acquireSlot();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private limit(): number {
    const raw = this.limitFn();
    return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.limit()) {
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

  private releaseSlot(): void {
    this.active--;
    while (this.active < this.limit() && this.waiting.length > 0) {
      this.waiting.shift()?.();
    }
  }
}

export function createDynamicConcurrencyGate(
  limitFn: () => number,
): ConcurrencyGate {
  return new DynamicSemaphore(limitFn);
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
