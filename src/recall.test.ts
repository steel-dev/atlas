import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runRecall,
  runSurvey,
  scopeQuestion,
  selectNovelUrls,
  RECALL_MAX_FETCH,
} from "./recall.js";
import { execFetch } from "./fetch-tool.js";
import type { MergedSearchResult } from "./search-tool.js";
import type { ModelAdapter } from "./model.js";
import type { SearchProvider } from "./search-provider.js";
import type { ResearchClaim } from "./claims.js";
import { createAgentScope, type ResearchCtx } from "./runtime.js";

vi.mock("./fetch-tool.js", () => ({
  execFetch: vi.fn(),
}));

const execFetchMock = vi.mocked(execFetch);

function fakeAdapter(respond: () => unknown): ModelAdapter {
  return {
    provider: "anthropic",
    model: "fake",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    async step() {
      const value = respond();
      if (value instanceof Error) throw value;
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  };
}

function searchResult(url: string, position: number): MergedSearchResult {
  return {
    title: url,
    url,
    snippet: "",
    engine: "test",
    engineRank: position,
    engines: ["test"],
    queries: ["q"],
    score: 1 / (60 + position),
    engineOrder: 0,
  };
}

function providerReturning(urls: string[]): SearchProvider {
  return {
    name: "test",
    async searchQuery({ query }) {
      return {
        query,
        sources: [
          {
            source: "test",
            order: 0,
            results: urls.map((url, index) => ({
              title: url,
              url,
              snippet: "",
              domain: "example.com",
              position: index + 1,
            })),
          },
        ],
        attempted: ["test"],
        warnings: [],
        sawEmptyResults: false,
      };
    },
  };
}

function makeCtx(opts: {
  adapter?: ModelAdapter;
  provider?: SearchProvider;
  claims?: ResearchClaim[];
}): ResearchCtx & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const claims = opts.claims ?? [];
  return {
    config: { useProxy: false, sourceCap: 100 },
    deps: {
      model: opts.adapter ?? fakeAdapter(() => ({})),
      steel: {} as ResearchCtx["deps"]["steel"],
      throwIfAborted: () => {},
      ioGate: { run: (fn) => fn() },
      browserSessionPool:
        {} as unknown as ResearchCtx["deps"]["browserSessionPool"],
      ...(opts.provider ? { searchProvider: opts.provider } : {}),
    },
    store: {
      fetchedSources: [],
      sourceDocuments: new Map(),
      sourceDocumentsById: new Map(),
      sourceReservations: {
        urls: new Set(),
        sourceSlots: 0,
        nextSourceNumber: 1,
        documents: new Map(),
      },
      caches: { serp: new Map(), sources: new Map() },
      claims: {
        claims,
        unsupportedCount: 0,
        queue: () => {},
        settle: async () => {},
      },
    },
    scope: createAgentScope({
      sink: (event) => events.push(event as Record<string, unknown>),
      query: "test question",
    }),
    events,
  } as ResearchCtx & { events: Array<Record<string, unknown>> };
}

beforeEach(() => {
  execFetchMock.mockReset();
  execFetchMock.mockImplementation(async (args) => ({
    text: "{}",
    fetchedUrls: Array.isArray(args.urls) ? [...args.urls] : [],
  }));
});

describe("scopeQuestion", () => {
  it("parses angles from structured output", async () => {
    const adapter = fakeAdapter(() => ({
      strategy: "split by domain",
      angles: [
        { label: "primary", query: "alpha" },
        { label: "skeptic", query: "alpha criticism", rationale: "balance" },
      ],
    }));
    const ctx = makeCtx({ adapter });
    const scope = await scopeQuestion(ctx, "alpha?");
    expect(scope.strategy).toBe("split by domain");
    expect(scope.angles).toHaveLength(2);
    expect(scope.angles[1]).toMatchObject({
      label: "skeptic",
      rationale: "balance",
    });
  });

  it("falls back to a single primary angle on malformed output", async () => {
    const ctx = makeCtx({ adapter: fakeAdapter(() => ({ angles: "no" })) });
    const scope = await scopeQuestion(ctx, "alpha?");
    expect(scope.angles).toEqual([{ label: "primary", query: "alpha?" }]);
  });

  it("falls back to a single primary angle when the model errors", async () => {
    const ctx = makeCtx({
      adapter: fakeAdapter(() => new Error("model down")),
    });
    const scope = await scopeQuestion(ctx, "alpha?");
    expect(scope.angles).toEqual([{ label: "primary", query: "alpha?" }]);
  });
});

describe("selectNovelUrls", () => {
  it("interleaves lists round-robin and dedupes across them", () => {
    const ctx = makeCtx({});
    const selection = selectNovelUrls(
      ctx,
      [
        [searchResult("https://a.com/1", 1), searchResult("https://a.com/2", 2)],
        [searchResult("https://a.com/1", 1), searchResult("https://b.com/1", 2)],
      ],
      10,
    );
    expect(selection.urls).toEqual([
      "https://a.com/1",
      "https://b.com/1",
      "https://a.com/2",
    ]);
    expect(selection.urlDupes).toBe(1);
  });

  it("skips urls already stored as source documents", () => {
    const ctx = makeCtx({});
    ctx.store.sourceDocuments.set(
      "https://a.com/1",
      {} as never,
    );
    const selection = selectNovelUrls(
      ctx,
      [[searchResult("https://a.com/1", 1), searchResult("https://a.com/2", 2)]],
      10,
    );
    expect(selection.urls).toEqual(["https://a.com/2"]);
    expect(selection.urlDupes).toBe(1);
  });

  it("drops urls beyond the slot budget and counts them", () => {
    const ctx = makeCtx({});
    const results = Array.from({ length: 8 }, (_, index) =>
      searchResult(`https://a.com/${index}`, index + 1),
    );
    const selection = selectNovelUrls(ctx, [results], 5);
    expect(selection.urls).toHaveLength(5);
    expect(selection.budgetDropped).toBe(3);
  });
});

describe("runRecall", () => {
  it("scopes, searches each angle, fetches novel urls, and emits scope_completed", async () => {
    const adapter = fakeAdapter(() => ({
      strategy: "two angles",
      angles: [
        { label: "a", query: "query a" },
        { label: "b", query: "query b" },
      ],
    }));
    const provider = providerReturning([
      "https://one.com/x",
      "https://two.com/y",
    ]);
    const ctx = makeCtx({ adapter, provider });

    const outcome = await runRecall(ctx, "test question");

    expect(outcome.angles).toHaveLength(2);
    expect(outcome.sourcesFetched).toBe(2);
    expect(ctx.events).toContainEqual(
      expect.objectContaining({
        type: "scope_completed",
        angles: [
          { label: "a", query: "query a" },
          { label: "b", query: "query b" },
        ],
      }),
    );
  });

  it("honors the recall fetch budget and chunks fetches into batches of at most 12 urls", async () => {
    const adapter = fakeAdapter(() => ({
      strategy: "three angles",
      angles: [
        { label: "a", query: "alpha" },
        { label: "b", query: "beta" },
        { label: "c", query: "gamma" },
      ],
    }));
    const perQueryProvider: SearchProvider = {
      name: "test",
      async searchQuery({ query }) {
        return {
          query,
          sources: [
            {
              source: "test",
              order: 0,
              results: Array.from({ length: 6 }, (_, index) => ({
                title: `${query}-${index}`,
                url: `https://${query}${index}.com/page`,
                snippet: "",
                domain: `${query}${index}.com`,
                position: index + 1,
              })),
            },
          ],
          attempted: ["test"],
          warnings: [],
          sawEmptyResults: false,
        };
      },
    };
    const ctx = makeCtx({ adapter, provider: perQueryProvider });

    const outcome = await runRecall(ctx, "test question");

    expect(outcome.budgetDropped).toBe(3);
    expect(outcome.sourcesFetched).toBe(RECALL_MAX_FETCH);
    const batches = execFetchMock.mock.calls.map(
      (call) => (call[0].urls ?? []).length,
    );
    expect(batches).toEqual([12, 3]);
  });
});

describe("runSurvey", () => {
  it("falls back to the goal as the only query and returns new claims", async () => {
    const provider = providerReturning(["https://new.com/a"]);
    const claims: ResearchClaim[] = [];
    const ctx = makeCtx({ provider, claims });
    execFetchMock.mockImplementationOnce(async (args) => {
      claims.push({
        id: "claim_1",
        text: "new fact",
        quote: "new fact",
        importance: "central",
        sourceQuality: "secondary",
        sourceId: "source_1",
        url: "https://new.com/a",
        title: "New",
        status: "quoted",
        votes: [],
      });
      return {
        text: "{}",
        fetchedUrls: Array.isArray(args.urls) ? [...args.urls] : [],
      };
    });

    const outcome = await runSurvey(ctx, {
      goal: "find the new fact",
      searchIndexStart: 0,
    });

    expect(outcome.queriesRun).toEqual(["find the new fact"]);
    expect(outcome.sourcesFetched).toBe(1);
    expect(outcome.newClaims).toHaveLength(1);
    expect(outcome.newClaims[0]?.id).toBe("claim_1");
  });

  it("caps explicit queries at three", async () => {
    const provider = providerReturning([]);
    const ctx = makeCtx({ provider });
    const outcome = await runSurvey(ctx, {
      goal: "goal",
      queries: ["q1", "q2", "q3", "q4", "q1"],
      searchIndexStart: 0,
    });
    expect(outcome.queriesRun).toEqual(["q1", "q2", "q3"]);
  });
});
