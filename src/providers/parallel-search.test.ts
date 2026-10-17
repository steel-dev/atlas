import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../agent.js";
import { resolveRunConfig } from "../config.js";
import { assembleRun } from "../context.js";
import { EventHub } from "../event-hub.js";
import { parallel } from "../index.js";
import { combineSearchProviders, defaultSearchProviders } from "./search.js";
import { JournalWriter, memoryStore } from "./store.js";

interface Rpc {
  id?: number;
  method: string;
  params?: Record<string, any>;
}

const data = {
  results: [
    { url: "file:///private", excerpts: ["skip non-web URLs"] },
    {
      url: "https://www.example.com/research",
      title: " Research page ",
      excerpts: ["First excerpt", "Second excerpt"],
    },
    { url: "https://example.org/other", title: null, excerpts: [] },
  ],
};

function mcpFixture(
  result: Record<string, unknown> = { structuredContent: data, content: [] },
  options: {
    sse?: boolean;
    hang?: string;
    status?: number;
    hold?: Promise<void>;
    onHold?: () => void;
  } = {},
) {
  const requests: { rpc?: Rpc; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    expect(String(input)).toBe("https://search.parallel.ai/mcp");
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toBe(
      "atlas (https://github.com/steel-dev/atlas)",
    );
    const rpc: Rpc | undefined = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    requests.push({ rpc, init });
    if (rpc?.method === "tools/call" && options.hold) {
      options.onHold?.();
      await options.hold;
    }
    if (rpc?.method === options.hang) {
      await new Promise<never>((_, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (!rpc) return new Response(null, { status: 405 });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === "tools/call" && options.status) {
      return new Response("Invalid request", { status: options.status });
    }
    const message = {
      jsonrpc: "2.0",
      id: rpc.id,
      result:
        rpc.method === "initialize"
          ? {
              protocolVersion: rpc.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1.0.0" },
            }
          : result,
    };
    return new Response(
      options.sse
        ? `event: message\ndata: ${JSON.stringify(message)}\n\n`
        : JSON.stringify(message),
      {
        headers: {
          "content-type": options.sse
            ? "text/event-stream"
            : "application/json",
        },
      },
    );
  });
  return requests;
}

beforeEach(() => {
  for (const name of ["TAVILY", "EXA", "BRAVE", "PARALLEL"]) {
    vi.stubEnv(`${name}_API_KEY`, "");
    vi.stubEnv(`ATLAS_${name}_API_KEY`, "");
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parallel.search", () => {
  it("uses anonymous HTTP MCP and normalizes results with a client-side limit", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "saved-task-key");
    vi.stubEnv("ATLAS_PARALLEL_API_KEY", "saved-atlas-task-key");
    const requests = mcpFixture();
    const provider = parallel.search();
    expect(
      await provider.search({
        query: "browser automation research",
        maxResults: 1,
      }),
    ).toEqual([
      {
        position: 1,
        title: "Research page",
        url: "https://www.example.com/research",
        snippet: "First excerpt … Second excerpt",
        domain: "example.com",
      },
    ]);
    expect(requests.map((r) => r.rpc?.method)).toContain("initialize");
    const call = requests.find((r) => r.rpc?.method === "tools/call")?.rpc;
    expect(call?.params).toMatchObject({
      name: "web_search",
      arguments: {
        objective: "browser automation research",
        search_queries: ["browser automation research"],
      },
    });
    expect(call?.params?.arguments.session_id).toMatch(/^[a-f0-9-]{36}$/);
    for (const request of requests) {
      expect(new Headers(request.init?.headers).has("authorization")).toBe(
        false,
      );
    }
    await provider.search({ query: "related research" });
    const ids = requests
      .filter((r) => r.rpc?.method === "tools/call")
      .map((r) => r.rpc?.params?.arguments.session_id);
    expect(new Set(ids).size).toBe(1);
  });

  it("accepts text JSON results delivered over SSE and only uses an explicitly passed key", async () => {
    const requests = mcpFixture(
      { content: [{ type: "text", text: JSON.stringify(data) }] },
      { sse: true },
    );
    const results = await parallel
      .search({ apiKey: "explicit-key" })
      .search({ query: "research" });
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({
      title: "https://example.org/other",
      snippet: "",
    });
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer explicit-key",
      );
    }
  });

  it("feeds selected-provider results into Atlas search candidates and tool output", async () => {
    mcpFixture();
    let turns = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async ({
        prompt,
      }): Promise<LanguageModelV3GenerateResult> => {
        const first = turns++ === 0;
        if (!first) {
          expect(JSON.stringify(prompt)).toContain(
            "https://www.example.com/research",
          );
          expect(JSON.stringify(prompt)).toContain(
            "First excerpt … Second excerpt",
          );
        }
        return {
          content: first
            ? [
                {
                  type: "tool-call",
                  toolCallId: "parallel-call",
                  toolName: "search",
                  input: JSON.stringify({
                    queries: ["browser automation research"],
                    limit: 1,
                  }),
                },
              ]
            : [{ type: "text", text: "Found the research page." }],
          finishReason: {
            unified: first ? "tool-calls" : "stop",
            raw: undefined,
          },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const config = {
      model,
      search: parallel.search(),
    };
    const journal = new JournalWriter(memoryStore(), "parallel-test");
    const { rctx } = await assembleRun({
      config,
      resolved: resolveRunConfig(config, {}),
      runId: "parallel-test",
      question: "browser automation research",
      todayISO: "2026-10-17",
      journal,
      hub: new EventHub(),
      hardSignal: new AbortController().signal,
      stopSignal: new AbortController().signal,
      now: Date.now,
      startedAt: Date.now(),
    });
    try {
      expect(rctx.search.providers.map((p) => p.id)).toEqual(["parallel"]);
      const output = await runAgent(rctx, {
        role: "research",
        modelRole: "research",
        task: "browser automation research",
        system: "Search for a research page.",
        tools: ["search"],
        grant: rctx.meter,
        depth: 0,
        maxTurns: 2,
      });
      expect(output.note).toBe("Found the research page.");
      expect(turns).toBe(2);
      expect(rctx.surfacedCandidates.size).toBe(1);
      expect(rctx.counters.searches).toBe(1);
    } finally {
      await journal.flush();
      await rctx.safeDispatcher.close();
    }
  });

  it("preserves automatic keyed providers and native fallback", () => {
    const model = new MockLanguageModelV3();
    expect(defaultSearchProviders(model).map((p) => p.id)).toEqual([
      "model-native",
    ]);
    vi.stubEnv("EXA_API_KEY", "exa-key");
    expect(defaultSearchProviders(model).map((p) => p.id)).toEqual(["exa"]);
    expect(parallel.agent).toBeTypeOf("function");
  });

  it.each([
    { content: [{ type: "text", text: "not JSON" }] },
    { structuredContent: { unexpected: [] }, content: [] },
  ])("rejects malformed tool results", async (result) => {
    mcpFixture(result);
    await expect(parallel.search().search({ query: "q" })).rejects.toThrow();
  });

  it("surfaces tool errors instead of treating them as empty results", async () => {
    mcpFixture({
      isError: true,
      content: [{ type: "text", text: "Quota exceeded" }],
    });
    await expect(parallel.search().search({ query: "q" })).rejects.toThrow(
      "Quota exceeded",
    );
    const output = await combineSearchProviders([parallel.search()]).run({
      query: "q",
    });
    expect(output.merged).toEqual([]);
    expect(output.warnings).toEqual([
      "parallel: parallel.search: Quota exceeded",
    ]);
  });

  it("surfaces HTTP errors", async () => {
    mcpFixture(undefined, { status: 400 });
    await expect(
      parallel.search().search({ query: "q" }),
    ).rejects.toMatchObject({
      code: 400,
      message: expect.stringContaining("Invalid request"),
    });
  });

  it("does not connect when already cancelled", async () => {
    const requests = mcpFixture();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      parallel.search().search({ query: "q", signal: controller.signal }),
    ).rejects.toThrow("stopped");
    expect(requests).toHaveLength(0);
  });

  it.each([
    "initialize",
    "tools/call",
  ])("cancels an in-flight %s request", async (hang) => {
    const requests = mcpFixture(undefined, { hang });
    const controller = new AbortController();
    const pending = parallel
      .search()
      .search({ query: "q", signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error("stopped")), 50);
    try {
      await expect(pending).rejects.toThrow("stopped");
      expect(
        requests.find((r) => r.rpc?.method === hang)?.init?.signal?.aborted,
      ).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([
    "initialize",
    "tools/call",
  ])("bounds a stalled %s request with the total timeout", async (hang) => {
    const requests = mcpFixture(undefined, { hang });
    await expect(
      parallel.search({ timeoutMs: 50 }).search({ query: "q" }),
    ).rejects.toThrow();
    expect(
      requests.find((r) => r.rpc?.method === hang)?.init?.signal?.aborted,
    ).toBe(true);
  });

  it("allows a configured timeout longer than the MCP SDK default", async () => {
    let release!: () => void;
    let onHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      onHold = resolve;
    });
    mcpFixture(undefined, { hold, onHold });
    vi.useFakeTimers();
    try {
      const pending = parallel
        .search({ timeoutMs: 120_000 })
        .search({ query: "q" });
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await ready;
      await vi.advanceTimersByTimeAsync(61_000);
      expect(settled).toBe(false);
      release();
      expect(await pending).toHaveLength(2);
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});
