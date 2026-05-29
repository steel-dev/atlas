import WebSocket from "ws";

const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 10_000;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingEvent {
  method: string;
  sessionId?: string;
  predicate?: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface CdpResponse {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: unknown;
  params?: unknown;
  error?: {
    message?: string;
    data?: string;
  };
}

export interface CdpCommandOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export class BrowserCdpClient {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventWaiters: PendingEvent[] = [];

  private constructor(private readonly ws: WebSocket) {
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", () => this.failAll(new Error("CDP connection closed")));
    this.ws.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  static async connect(
    websocketUrl: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<BrowserCdpClient> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(websocketUrl);
      const timeout = setTimeout(() => {
        finish(new Error(`CDP connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => finish(new Error("CDP connection aborted"));
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onAbort);
        if (err) {
          ws.close();
          reject(err);
        } else {
          resolve(new BrowserCdpClient(ws));
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      ws.once("open", () => finish());
      ws.once("error", (err) =>
        finish(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts: CdpCommandOptions = {},
  ): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP connection is not open"));
    }
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    const payload = {
      id,
      method,
      ...(params ? { params } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(err);
      });
    });
  }

  waitForEvent<T = unknown>(
    method: string,
    opts: {
      sessionId?: string;
      timeoutMs?: number;
      predicate?: (params: unknown) => boolean;
    } = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const waiter: PendingEvent = {
        method,
        sessionId: opts.sessionId,
        predicate: opts.predicate,
        resolve: (params) => resolve(params as T),
        reject,
        timeout: setTimeout(() => {
          this.removeEventWaiter(waiter);
          reject(new Error(`CDP event timed out: ${method}`));
        }, timeoutMs),
      };
      this.eventWaiters.push(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.ws.close();
    this.failAll(new Error("CDP connection closed"));
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(data.toString()) as CdpResponse;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.data
              ? `${message.error.message ?? "CDP error"}: ${message.error.data}`
              : (message.error.message ?? "CDP error"),
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    for (const waiter of [...this.eventWaiters]) {
      if (waiter.method !== message.method) continue;
      if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
      if (waiter.predicate && !waiter.predicate(message.params)) continue;
      clearTimeout(waiter.timeout);
      this.removeEventWaiter(waiter);
      waiter.resolve(message.params);
    }
  }

  private removeEventWaiter(waiter: PendingEvent): void {
    const index = this.eventWaiters.indexOf(waiter);
    if (index >= 0) this.eventWaiters.splice(index, 1);
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.reject(err);
    }
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(err);
    }
  }
}
