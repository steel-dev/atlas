import { describe, expect, it } from "vitest";
import { createResearchStreamController } from "./research-stream.js";
import type { ResearchEventListener, ResearchResult } from "./research.js";

function fakeResult(markdown: string): ResearchResult {
  return {
    query: "q",
    provider: "anthropic",
    model: "m",
    markdown,
    capBound: false,
    openQuestions: [],
    caveats: [],
    claims: { confirmed: [], refuted: [], unverified: [] },
    stats: {
      angles: 1,
      searchesRun: 1,
      sourcesFetched: 1,
      claimsExtracted: 0,
      claimsUnsupported: 0,
      claimsVerified: 0,
      confirmed: 0,
      refuted: 0,
      unverified: 0,
      beyondVerifyCap: 0,
      recallUrlDupes: 0,
      recallBudgetDropped: 0,
      recallSpamDropped: 0,
      recallLowRelevanceDropped: 0,
      leadToolCalls: 0,
      surveys: 0,
      reanchors: 0,
    },
    citedSources: [{ url: "https://example.com", title: "Example" }],
    citationsNotConfirmed: [],
    citationsNotFetched: [],
    finishReason: "gaps assessed",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    leadUsage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    leafUsage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

describe("research stream controller", () => {
  it("resolves result and derived fields without draining the stream", async () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    controller.emit({ type: "research_started" });
    controller.emit({ type: "fetching", url: "https://example.com" });
    controller.emit({ type: "report_boundary" });
    controller.emit({ type: "report_delta", text: "Hello" });
    const result = fakeResult("# Report");
    controller.resolve(result);
    controller.close();

    await expect(stream.result).resolves.toBe(result);
    await expect(stream.markdown).resolves.toBe("# Report");
    await expect(stream.citedSources).resolves.toEqual([
      { url: "https://example.com", title: "Example" },
    ]);
    await expect(stream.usage).resolves.toMatchObject({ output_tokens: 2 });
  });

  it("splits events across fullStream, events, and textStream views", async () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    const fullSeen: string[] = [];
    const eventSeen: string[] = [];
    const text: string[] = [];
    const collectFull = (async () => {
      for await (const event of stream.fullStream) fullSeen.push(event.type);
    })();
    const collectEvents = (async () => {
      for await (const event of stream.events) eventSeen.push(event.type);
    })();
    const collectText = (async () => {
      for await (const chunk of stream.textStream) text.push(chunk);
    })();
    await Promise.resolve();

    controller.emit({ type: "research_started" });
    controller.emit({ type: "report_boundary" });
    controller.emit({ type: "report_delta", text: "Hel" });
    controller.emit({ type: "report_delta", text: "lo" });
    controller.emit({ type: "written", markdownChars: 5 });
    controller.resolve(fakeResult("Hello"));
    controller.close();
    await Promise.all([collectFull, collectEvents, collectText]);

    expect(fullSeen).toEqual([
      "research_started",
      "report_boundary",
      "report_delta",
      "report_delta",
      "written",
    ]);
    expect(eventSeen).toEqual(["research_started", "written"]);
    expect(text.join("")).toBe("Hello");
  });

  it("drops events emitted before any subscriber attaches", async () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    controller.emit({ type: "research_started" });
    const seen: string[] = [];
    const collect = (async () => {
      for await (const event of stream.fullStream) seen.push(event.type);
    })();
    await Promise.resolve();
    controller.emit({ type: "fetching", url: "u" });
    controller.resolve(fakeResult("x"));
    controller.close();
    await collect;

    expect(seen).toEqual(["fetching"]);
  });

  it("propagates a run failure to both the stream and the result promise", async () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });
    const failure = new Error("boom");

    const seen: string[] = [];
    const collect = (async () => {
      try {
        for await (const event of stream.fullStream) seen.push(event.type);
        return null;
      } catch (err) {
        return err;
      }
    })();
    await Promise.resolve();
    controller.emit({ type: "research_started" });
    controller.reject(failure);

    await expect(stream.result).rejects.toBe(failure);
    await expect(collect).resolves.toBe(failure);
    expect(seen).toEqual(["research_started"]);
  });

  it("routes abort and stop to the provided controls", () => {
    let aborted = 0;
    let stopped = 0;
    const controller = createResearchStreamController();
    const stream = controller.build({
      abort: () => {
        aborted++;
      },
      stop: () => {
        stopped++;
      },
    });

    stream.abort();
    stream.stop();

    expect(aborted).toBe(1);
    expect(stopped).toBe(1);
  });

  it("delivers type-filtered events to .on listeners and supports unsubscribe", () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    const urls: string[] = [];
    const unsubscribe = stream.on("fetching", (event) => {
      urls.push(event.url);
    });

    controller.emit({ type: "fetching", url: "https://a.com" });
    controller.emit({ type: "research_started" });
    controller.emit({ type: "fetching", url: "https://b.com" });
    unsubscribe();
    controller.emit({ type: "fetching", url: "https://c.com" });

    expect(urls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("fires a once listener a single time", () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    const texts: string[] = [];
    stream.once("report_delta", (event) => {
      texts.push(event.text);
    });

    controller.emit({ type: "report_delta", text: "a" });
    controller.emit({ type: "report_delta", text: "b" });

    expect(texts).toEqual(["a"]);
  });

  it("removes a listener by reference with off", () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    const texts: string[] = [];
    const listener: ResearchEventListener<"report_delta"> = (event) => {
      texts.push(event.text);
    };
    stream.on("report_delta", listener);

    controller.emit({ type: "report_delta", text: "a" });
    stream.off("report_delta", listener);
    controller.emit({ type: "report_delta", text: "b" });

    expect(texts).toEqual(["a"]);
  });

  it("isolates a throwing listener from the rest of the broadcast", () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    const seen: string[] = [];
    stream.on("fetching", () => {
      throw new Error("listener boom");
    });
    stream.on("fetching", (event) => {
      seen.push(event.url);
    });

    expect(() =>
      controller.emit({ type: "fetching", url: "https://a.com" }),
    ).not.toThrow();
    expect(seen).toEqual(["https://a.com"]);
  });

  it("stops delivering to listeners after the run settles", async () => {
    const controller = createResearchStreamController();
    const stream = controller.build({ abort: () => {}, stop: () => {} });

    let count = 0;
    stream.on("fetching", () => {
      count++;
    });

    controller.emit({ type: "fetching", url: "https://a.com" });
    controller.resolve(fakeResult("done"));
    controller.close();
    controller.emit({ type: "fetching", url: "https://b.com" });

    await stream.result;
    expect(count).toBe(1);
  });
});
