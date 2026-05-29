import type Steel from "steel-sdk";
import { BrowserCdpClient } from "./browser-cdp.js";
import { errorMessage } from "./errors.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 45_000;
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
const MIN_SESSION_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_SAFETY_MS = 15_000;
const CDP_CONNECT_ATTEMPTS = 6;
const CDP_CONNECT_BASE_DELAY_MS = 500;

type SteelSession = Awaited<ReturnType<Steel["sessions"]["create"]>>;

export interface BrowserSessionResource {
  session: SteelSession;
  client: BrowserCdpClient;
  cdpSessionId?: string;
  lastUsedAt: number;
}

export interface BrowserSessionLease {
  resource: BrowserSessionResource;
  release: (opts?: { discard?: boolean }) => Promise<void>;
}

interface Waiter {
  resolve: (lease: BrowserSessionLease) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface BrowserSessionPoolOptions {
  steel: Steel;
  useProxy: boolean;
  namespace: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  maxSessions?: number;
  idleTtlMs?: number;
  acquireTimeoutMs?: number;
}

export class BrowserSessionPool {
  private readonly idle: BrowserSessionResource[] = [];
  private readonly active = new Set<BrowserSessionResource>();
  private readonly waiters: Waiter[] = [];
  private readonly idleTimers = new Map<BrowserSessionResource, NodeJS.Timeout>();
  private creating = 0;
  private learnedCapacity: number | null = null;
  private closed = false;

  constructor(private readonly opts: BrowserSessionPoolOptions) {}

  async acquire(): Promise<BrowserSessionLease> {
    if (this.closed) throw new Error("Browser session pool is closed");
    const idle = this.idle.pop();
    if (idle) {
      this.clearIdleTimer(idle);
      return this.lease(idle);
    }

    if (this.canCreate()) {
      try {
        this.creating++;
        const resource = await this.createResource();
        return this.lease(resource);
      } catch (err) {
        if (!isSessionLimitError(err)) throw err;
        this.learnedCapacity = this.totalSessions();
        if (this.learnedCapacity === 0) {
          throw new Error(`Steel session limit reached before acquiring a session: ${errorMessage(err)}`);
        }
      } finally {
        this.creating = Math.max(0, this.creating - 1);
      }
    }

    return this.waitForLease();
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const err = new Error("Browser session pool is closing");
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(err);
    }
    const resources = [...this.idle, ...this.active];
    this.idle.length = 0;
    this.active.clear();
    await Promise.allSettled(resources.map((resource) => this.destroy(resource)));
  }

  private canCreate(): boolean {
    const total = this.totalSessions();
    const hardCap = this.opts.maxSessions;
    if (hardCap !== undefined && total >= hardCap) return false;
    if (this.learnedCapacity !== null && total >= this.learnedCapacity) {
      return false;
    }
    return true;
  }

  private totalSessions(): number {
    return this.idle.length + this.active.size + this.creating;
  }

  private async waitForLease(): Promise<BrowserSessionLease> {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
      const waiter: Waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for browser session after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private lease(resource: BrowserSessionResource): BrowserSessionLease {
    this.active.add(resource);
    let released = false;
    return {
      resource,
      release: async (opts = {}) => {
        if (released) return;
        released = true;
        this.active.delete(resource);
        resource.lastUsedAt = Date.now();
        if (opts.discard || this.closed) {
          await this.destroy(resource);
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timeout);
          waiter.resolve(this.lease(resource));
          return;
        }
        this.idle.push(resource);
        this.setIdleTimer(resource);
      },
    };
  }

  private async createResource(): Promise<BrowserSessionResource> {
    const session = await this.opts.steel.sessions.create(
      {
        namespace: this.opts.namespace,
        useProxy: this.opts.useProxy,
        headless: true,
        timeout: this.sessionTimeoutMs(),
        optimizeBandwidth: {
          blockImages: true,
          blockMedia: true,
        },
        debugConfig: {
          interactive: false,
        },
      },
      { signal: this.opts.signal },
    );
    try {
      const client = await this.connectToSession(session);
      const cdpSessionId = await attachToPage(client);
      return {
        session,
        client,
        ...(cdpSessionId ? { cdpSessionId } : {}),
        lastUsedAt: Date.now(),
      };
    } catch (err) {
      await this.releaseSteelSession(session.id);
      throw err;
    }
  }

  private async connectToSession(session: SteelSession): Promise<BrowserCdpClient> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CDP_CONNECT_ATTEMPTS; attempt++) {
      this.opts.signal?.throwIfAborted();
      const websocketUrl = await this.websocketUrlForAttempt(session, attempt);
      try {
        return await BrowserCdpClient.connect(websocketUrl, {
          signal: this.opts.signal,
        });
      } catch (err) {
        lastError = err;
        if (!isTransientCdpConnectError(err) || attempt >= CDP_CONNECT_ATTEMPTS) {
          break;
        }
        await delay(CDP_CONNECT_BASE_DELAY_MS * attempt, this.opts.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  }

  private async websocketUrlForAttempt(
    session: SteelSession,
    attempt: number,
  ): Promise<string> {
    if (attempt === 1) return this.withWebsocketApiKey(session.websocketUrl);
    try {
      const liveDetails = await this.opts.steel.sessions.liveDetails(session.id, {
        signal: this.opts.signal,
      });
      return this.withWebsocketApiKey(liveDetails.wsUrl || session.websocketUrl);
    } catch {
      return this.withWebsocketApiKey(session.websocketUrl);
    }
  }

  private withWebsocketApiKey(websocketUrl: string): string {
    const apiKey = this.opts.steel.steelAPIKey;
    if (!apiKey) return websocketUrl;
    try {
      const url = new URL(websocketUrl);
      if (!url.searchParams.has("apiKey")) {
        url.searchParams.set("apiKey", apiKey);
      }
      return url.toString();
    } catch {
      const separator = websocketUrl.includes("?") ? "&" : "?";
      return /[?&]apiKey=/.test(websocketUrl)
        ? websocketUrl
        : `${websocketUrl}${separator}apiKey=${encodeURIComponent(apiKey)}`;
    }
  }

  private sessionTimeoutMs(): number {
    if (this.opts.deadlineAt === undefined) return DEFAULT_SESSION_TIMEOUT_MS;
    const remaining = Math.max(0, this.opts.deadlineAt - Date.now());
    return Math.max(
      MIN_SESSION_TIMEOUT_MS,
      Math.min(DEFAULT_SESSION_TIMEOUT_MS, remaining + SESSION_TIMEOUT_SAFETY_MS),
    );
  }

  private setIdleTimer(resource: BrowserSessionResource): void {
    const ttl = this.opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.clearIdleTimer(resource);
    this.idleTimers.set(
      resource,
      setTimeout(() => {
        const index = this.idle.indexOf(resource);
        if (index >= 0) this.idle.splice(index, 1);
        void this.destroy(resource);
      }, ttl),
    );
  }

  private clearIdleTimer(resource: BrowserSessionResource): void {
    const timer = this.idleTimers.get(resource);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(resource);
  }

  private async destroy(resource: BrowserSessionResource): Promise<void> {
    this.clearIdleTimer(resource);
    resource.client.close();
    await this.releaseSteelSession(resource.session.id);
  }

  private async releaseSteelSession(sessionId: string): Promise<void> {
    try {
      await this.opts.steel.sessions.release(sessionId, {}, { signal: this.opts.signal });
    } catch {
      // Session timeout/release races are harmless during cleanup.
    }
  }
}

export function readBrowserMaxSessionsFromEnv(): number | undefined {
  const raw = process.env.ATLAS_BROWSER_MAX_SESSIONS;
  if (!raw) return undefined;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function attachToPage(client: BrowserCdpClient): Promise<string | undefined> {
  try {
    const targets = await client.send<{
      targetInfos?: Array<{ targetId: string; type: string; url?: string }>;
    }>("Target.getTargets");
    let page = targets.targetInfos?.find((target) => target.type === "page");
    if (!page) {
      const created = await client.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      page = { targetId: created.targetId, type: "page" };
    }
    const attached = await client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      {
        targetId: page.targetId,
        flatten: true,
      },
    );
    await Promise.allSettled([
      client.send("Page.enable", {}, { sessionId: attached.sessionId }),
      client.send("Runtime.enable", {}, { sessionId: attached.sessionId }),
      client.send("DOM.enable", {}, { sessionId: attached.sessionId }),
      client.send("Network.enable", {}, { sessionId: attached.sessionId }),
    ]);
    return attached.sessionId;
  } catch {
    await Promise.allSettled([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("DOM.enable"),
      client.send("Network.enable"),
    ]);
    return undefined;
  }
}

function isSessionLimitError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = errorMessage(err);
  return (
    status === 409 ||
    status === 429 ||
    /\b(?:concurrency|session|limit|quota|capacity)\b/i.test(message)
  );
}

function isTransientCdpConnectError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    /Unexpected server response:\s*(?:502|503|504)/i.test(message) ||
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up)\b/i.test(message)
  );
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
