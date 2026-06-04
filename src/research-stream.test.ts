import { describe, expect, it } from "vitest";
import { createResearchStreamController } from "./research-stream.js";
import type { ResearchResult } from "./research.js";

function fakeResult(markdown: string): ResearchResult {
  return {
    query: "q",
    provider: "anthropic",
    model: "m",
    markdown,
    openQuestions: [],
    claims: { confirmed: [], refuted: [], unverified: [] },
    stats: {
      angles: 1,
      sourcesFetched: 1,
      claimsExtracted: 0,
      claimsUnsupported: 0,
      claimsVerified: 0,
      confirmed: 0,
      refuted: 0,
      unverified: 0,
      beyondVerifyCap: 0,
      clustersFormed: 0,
      claimsDeduped: 0,
      recallUrlDupes: 0,
      recallBudgetDropped: 0,
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
});
