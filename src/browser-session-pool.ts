import type Steel from "steel-sdk";
import { BrowserCdpClient } from "./browser-cdp.js";
import { errorMessage } from "./errors.js";
import { sleep } from "./async.js";

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 2 * 60_000;
const DEFAULT_BROWSER_SESSIONS_PER_AGENT = 4;
const MIN_DEFAULT_BROWSER_SESSIONS = 8;
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
const MIN_SESSION_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_SAFETY_MS = 15_000;
const CDP_CONNECT_ATTEMPTS = 6;
const CDP_CONNECT_BASE_DELAY_MS = 500;
const CDP_HEALTHCHECK_TIMEOUT_MS = 2_000;
const SESSION_RELEASE_TIMEOUT_MS = 10_000;

type SteelSession = Awaited<ReturnType<Steel["sessions"]["create"]>>;

interface BrowserSessionResource {
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

interface BrowserSessionPoolOptions {
  steel: Steel;
  useProxy: boolean;
  namespace: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  maxSessions?: number;
  /** When null or <= 0, idle sessions stay open until closeAll(). */
  idleTtlMs?: number | null;
  acquireTimeoutMs?: number;
}

export class BrowserSessionPool {
  private readonly idle: BrowserSessionResource[] = [];
  private readonly active = new Set<BrowserSessionResource>();
  private readonly waiters: Waiter[] = [];
  private readonly idleTimers = new Map<
    BrowserSessionResource,
    NodeJS.Timeout
  >();
  private creating = 0;
  private learnedCapacity: number | null = null;
  private closed = false;
  private readonly maxSessions: number;

  constructor(private readonly opts: BrowserSessionPoolOptions) {
    this.maxSessions = opts.maxSessions ?? defaultBrowserMaxSessions();
  }

  async acquire(): Promise<BrowserSessionLease> {
    if (this.closed) throw new Error("Browser session pool is closed");
    while (this.idle.length > 0) {
      const idle = this.idle.pop();
      if (!idle) break;
      this.clearIdleTimer(idle);
      if (await this.isHealthy(idle)) {
        return this.lease(idle);
      }
      await this.destroy(idle);
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
          throw new Error(
            `Steel session limit reached before acquiring a session: ${errorMessage(err)}`,
          );
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
    await Promise.allSettled(
      resources.map((resource) => this.destroy(resource)),
    );
  }

  private canCreate(): boolean {
    const total = this.totalSessions();
    if (total >= this.maxSessions) return false;
    if (this.learnedCapacity !== null && total >= this.learnedCapacity) {
      return false;
    }
    return true;
  }

  private effectiveCapacity(): number {
    return this.learnedCapacity !== null
      ? Math.min(this.maxSessions, this.learnedCapacity)
      : this.maxSessions;
  }

  private totalSessions(): number {
    return this.idle.length + this.active.size + this.creating;
  }

  private async waitForLease(): Promise<BrowserSessionLease> {
    return new Promise((resolve, reject) => {
      const timeoutMs =
        this.opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
      const waiter: Waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `No browser session became available within ${timeoutMs}ms ` +
                `(${this.totalSessions()}/${this.effectiveCapacity()} sessions in use). ` +
                `Browser capacity is a shared limit — retry after other tool ` +
                `calls finish, or use the fetch tool to gather this URL without ` +
                `an interactive session.`,
            ),
          );
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
          await this.resolveWaiterWithResource(waiter, resource);
          return;
        }
        this.idle.push(resource);
        this.maybeSetIdleTimer(resource);
      },
    };
  }

  private async createResource(): Promise<BrowserSessionResource> {
    const session = await this.opts.steel.sessions.create(
      {
        namespace: this.opts.namespace,
        useProxy: this.opts.useProxy,
        timeout: this.sessionTimeoutMs(),
        optimizeBandwidth: {
          blockImages: true,
          blockMedia: true,
        },
        debugConfig: {
          interactive: true,
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

  private async isHealthy(resource: BrowserSessionResource): Promise<boolean> {
    if (!resource.client.isOpen()) return false;
    try {
      await resource.client.send(
        "Runtime.evaluate",
        { expression: "1", returnByValue: true },
        {
          ...(resource.cdpSessionId
            ? { sessionId: resource.cdpSessionId }
            : {}),
          timeoutMs: CDP_HEALTHCHECK_TIMEOUT_MS,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async resolveWaiterWithResource(
    waiter: Waiter,
    resource: BrowserSessionResource,
  ): Promise<void> {
    if (await this.isHealthy(resource)) {
      waiter.resolve(this.lease(resource));
      return;
    }
    await this.destroy(resource);
    try {
      this.creating++;
      waiter.resolve(this.lease(await this.createResource()));
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(errorMessage(err)));
    } finally {
      this.creating = Math.max(0, this.creating - 1);
    }
  }

  private async connectToSession(
    session: SteelSession,
  ): Promise<BrowserCdpClient> {
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
        if (
          !isTransientCdpConnectError(err) ||
          attempt >= CDP_CONNECT_ATTEMPTS
        ) {
          break;
        }
        await sleep(CDP_CONNECT_BASE_DELAY_MS * attempt, this.opts.signal);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(errorMessage(lastError));
  }

  private async websocketUrlForAttempt(
    session: SteelSession,
    attempt: number,
  ): Promise<string> {
    if (attempt === 1) return this.withWebsocketApiKey(session.websocketUrl);
    try {
      const liveDetails = await this.opts.steel.sessions.liveDetails(
        session.id,
        {
          signal: this.opts.signal,
        },
      );
      return this.withWebsocketApiKey(
        liveDetails.wsUrl || session.websocketUrl,
      );
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
      Math.min(
        DEFAULT_SESSION_TIMEOUT_MS,
        remaining + SESSION_TIMEOUT_SAFETY_MS,
      ),
    );
  }

  private maybeSetIdleTimer(resource: BrowserSessionResource): void {
    const ttl = this.opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    if (ttl <= 0) return;
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
      // Release must run to completion even when the run signal is already
      // aborted (e.g. Ctrl+C / timeout). Passing the aborted run signal here
      // would cancel the release request itself, leaving the session alive on
      // the server until its own timeout. Use a fresh short timeout instead.
      await this.opts.steel.sessions.release(
        sessionId,
        {},
        { signal: AbortSignal.timeout(SESSION_RELEASE_TIMEOUT_MS) },
      );
    } catch {
      // Session timeout/release races are harmless during cleanup.
    }
  }
}

export function defaultBrowserMaxSessions(extraAgents = 0): number {
  const agents = 1 + Math.max(0, Math.floor(extraAgents));
  return Math.max(
    MIN_DEFAULT_BROWSER_SESSIONS,
    agents * DEFAULT_BROWSER_SESSIONS_PER_AGENT,
  );
}

export function readBrowserMaxSessionsFromEnv(): number | undefined {
  const raw = process.env.ATLAS_BROWSER_MAX_SESSIONS;
  if (!raw) return undefined;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readBrowserIdleTtlMsFromEnv(): number | null | undefined {
  const raw = process.env.ATLAS_BROWSER_IDLE_TTL_MS;
  if (!raw) return undefined;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return undefined;
  return parsed <= 0 ? null : parsed;
}

async function attachToPage(
  client: BrowserCdpClient,
): Promise<string | undefined> {
  try {
    const targets = await client.send<{
      targetInfos?: Array<{ targetId: string; type: string; url?: string }>;
    }>("Target.getTargets");
    let page = targets.targetInfos?.find((target) => target.type === "page");
    if (!page) {
      const created = await client.send<{ targetId: string }>(
        "Target.createTarget",
        {
          url: "about:blank",
        },
      );
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
