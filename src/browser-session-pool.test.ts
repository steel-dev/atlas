import type Steel from "steel-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
vi.mock("./browser-cdp.js", () => ({
  BrowserCdpClient: {
    connect: (...args: unknown[]) => connectMock(...args),
  },
}));

import {
  BrowserSessionPool,
  defaultBrowserMaxSessions,
} from "./browser-session-pool.js";

function fakeClient() {
  return {
    isOpen: () => true,
    close: vi.fn(),
    waitForEvent: vi.fn(async () => undefined),
    send: vi.fn(async (method: string) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "target_1", type: "page" }] };
      }
      if (method === "Target.attachToTarget") {
        return { sessionId: "cdp_session_1" };
      }
      // Runtime.evaluate health checks, *.enable, etc.
      return {};
    }),
  };
}

function fakeSteel(): Steel & {
  sessions: { create: ReturnType<typeof vi.fn> };
} {
  let created = 0;
  return {
    steelAPIKey: "test-key",
    sessions: {
      create: vi.fn(async () => {
        created += 1;
        return {
          id: `session_${created}`,
          websocketUrl: `ws://test/${created}`,
        };
      }),
      release: vi.fn(async () => undefined),
      liveDetails: vi.fn(async () => ({ wsUrl: "ws://test/live" })),
    },
  } as unknown as Steel & { sessions: { create: ReturnType<typeof vi.fn> } };
}

function makePool(
  steel: Steel,
  overrides: { maxSessions?: number; acquireTimeoutMs?: number } = {},
) {
  return new BrowserSessionPool({
    steel,
    useProxy: false,
    namespace: "test",
    idleTtlMs: null,
    maxSessions: overrides.maxSessions ?? 1,
    acquireTimeoutMs: overrides.acquireTimeoutMs ?? 100,
  });
}

afterEach(() => {
  connectMock.mockReset();
});

describe("defaultBrowserMaxSessions", () => {
  it("scales the runaway ceiling with sub-agent concurrency, with a floor", () => {
    // 1 lead + N sub-agents, times the per-agent fetch-fallback headroom.
    expect(defaultBrowserMaxSessions(3)).toBe(16);
    expect(defaultBrowserMaxSessions(1)).toBe(8);
    // Never drops below the floor, even with no sub-agents.
    expect(defaultBrowserMaxSessions(0)).toBe(8);
    expect(defaultBrowserMaxSessions()).toBe(8);
  });
});

describe("BrowserSessionPool capacity", () => {
  it("applies backpressure with an actionable error once at capacity", async () => {
    connectMock.mockImplementation(async () => fakeClient());
    const steel = fakeSteel();
    const pool = makePool(steel, { maxSessions: 1, acquireTimeoutMs: 80 });

    const lease = await pool.acquire();

    // The pool is full and nothing is freed, so a second acquire waits the
    // timeout and rejects with guidance instead of creating a runaway session.
    await expect(pool.acquire()).rejects.toThrow(
      /No browser session became available within 80ms/,
    );
    await expect(pool.acquire()).rejects.toThrow(/use the fetch tool/);
    expect(steel.sessions.create).toHaveBeenCalledTimes(1);

    await lease.release();
    await pool.closeAll();
  });

  it("falls back to a finite default cap when none is configured", async () => {
    connectMock.mockImplementation(async () => fakeClient());
    const steel = fakeSteel();
    // No maxSessions override → the pool self-defaults instead of growing
    // without bound the way it used to.
    const pool = new BrowserSessionPool({
      steel,
      useProxy: false,
      namespace: "test",
      idleTtlMs: null,
      acquireTimeoutMs: 50,
    });

    const cap = defaultBrowserMaxSessions();
    const leases = [];
    for (let i = 0; i < cap; i += 1) leases.push(await pool.acquire());

    await expect(pool.acquire()).rejects.toThrow(
      /No browser session became available/,
    );
    expect(steel.sessions.create).toHaveBeenCalledTimes(cap);

    for (const lease of leases) await lease.release();
    await pool.closeAll();
  });

  it("hands a freed session to a waiter instead of creating a new one", async () => {
    connectMock.mockImplementation(async () => fakeClient());
    const steel = fakeSteel();
    const pool = makePool(steel, { maxSessions: 1, acquireTimeoutMs: 2_000 });

    const first = await pool.acquire();
    const pending = pool.acquire(); // queued behind the cap

    await first.release(); // releasing must satisfy the waiter, not time out

    const second = await pending;
    expect(second.resource.session.id).toBe("session_1"); // same session reused
    expect(steel.sessions.create).toHaveBeenCalledTimes(1);

    await second.release();
    await pool.closeAll();
  });
});
