import { describe, expect, it } from "vitest";
import {
  fetchYoutubeTranscript,
  isYoutubeWatchUrl,
  parseTranscriptBody,
  pickCaptionTrack,
  youtubeTranscriptToMarkdown,
  youtubeVideoId,
} from "./youtube.js";

const PLAYER = {
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?lang=en&kind=asr",
          languageCode: "en",
          kind: "asr",
          name: { simpleText: "English (auto-generated)" },
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
          languageCode: "en",
          name: { simpleText: "English" },
        },
        {
          baseUrl: "https://www.youtube.com/api/timedtext?lang=es",
          languageCode: "es",
          name: { simpleText: "Spanish" },
        },
      ],
    },
  },
  videoDetails: {
    title: "Test Video",
    author: "Test Channel",
    lengthSeconds: "75",
    shortDescription: "A short description.",
  },
};

const TRANSCRIPT_TEXT_XML =
  `<?xml version="1.0" encoding="utf-8"?><transcript>` +
  `<text start="0" dur="2">Hello &amp; welcome</text>` +
  `<text start="2" dur="3">It&amp;#39;s a test</text>` +
  `</transcript>`;

const TRANSCRIPT_P_XML =
  `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>` +
  `<p t="0" d="2000">first &amp; line</p>` +
  `<p t="2000" d="3000"><s>second</s><s> line</s></p>` +
  `</body></timedtext>`;

function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  return async (input: string) => {
    const key = Object.keys(routes).find((k) => input.includes(k));
    const hit = key ? routes[key] : undefined;
    const status = hit?.status ?? (hit ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => hit?.body ?? "",
    };
  };
}

describe("youtubeVideoId", () => {
  it("parses watch, short, embed, and youtu.be forms", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(youtubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(
      youtubeVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x"),
    ).toBe("dQw4w9WgXcQ");
  });

  it("rejects non-youtube and malformed urls", () => {
    expect(
      youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"),
    ).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(
      youtubeVideoId("https://www.youtube.com/feed/subscriptions"),
    ).toBeNull();
    expect(youtubeVideoId("not a url")).toBeNull();
    expect(isYoutubeWatchUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYoutubeWatchUrl("https://example.com")).toBe(false);
  });
});

describe("pickCaptionTrack", () => {
  it("prefers a manual track in the requested language", () => {
    const track = pickCaptionTrack(PLAYER, "en");
    expect(track?.languageCode).toBe("en");
    expect(track?.kind).toBeUndefined();
  });

  it("returns null when there are no caption tracks", () => {
    expect(pickCaptionTrack({}, "en")).toBeNull();
  });
});

describe("parseTranscriptBody", () => {
  it("parses <text> xml and decodes double-encoded entities", () => {
    expect(parseTranscriptBody(TRANSCRIPT_TEXT_XML)).toBe(
      "Hello & welcome\nIt's a test",
    );
  });

  it("parses <p> timedtext format and strips inner <s> segments", () => {
    expect(parseTranscriptBody(TRANSCRIPT_P_XML)).toBe(
      "first & line\nsecond line",
    );
  });

  it("parses json3 events", () => {
    const json3 = JSON.stringify({
      events: [
        { segs: [{ utf8: "hello" }, { utf8: " world" }] },
        { segs: [{ utf8: "second line" }] },
        { segs: [{ utf8: "\n" }] },
      ],
    });
    expect(parseTranscriptBody(json3)).toBe("hello world\nsecond line");
  });
});

describe("fetchYoutubeTranscript", () => {
  it("returns null for non-youtube urls", async () => {
    expect(
      await fetchYoutubeTranscript("https://example.com", {
        fetchImpl: fakeFetch({}),
      }),
    ).toBeNull();
  });

  it("calls the player endpoint and parses the caption track", async () => {
    const result = await fetchYoutubeTranscript(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      {
        fetchImpl: fakeFetch({
          "/youtubei/v1/player": { body: JSON.stringify(PLAYER) },
          timedtext: { body: TRANSCRIPT_TEXT_XML },
        }),
      },
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test Video");
    expect(result?.author).toBe("Test Channel");
    expect(result?.languageCode).toBe("en");
    expect(result?.kind).toBe("manual");
    expect(result?.lengthSeconds).toBe(75);
    expect(result?.text).toBe("Hello & welcome\nIt's a test");
    expect(result?.segmentCount).toBe(2);
  });

  it("falls back to json3 when the default track body is empty", async () => {
    const json3 = JSON.stringify({
      events: [{ segs: [{ utf8: "from json3" }] }],
    });
    const result = await fetchYoutubeTranscript(
      "https://youtu.be/dQw4w9WgXcQ",
      {
        fetchImpl: fakeFetch({
          "/youtubei/v1/player": { body: JSON.stringify(PLAYER) },
          "fmt=json3": { body: json3 },
          timedtext: { body: "" },
        }),
      },
    );
    expect(result?.text).toBe("from json3");
  });

  it("returns null when the player response has no captions", async () => {
    const result = await fetchYoutubeTranscript(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      {
        fetchImpl: fakeFetch({
          "/youtubei/v1/player": {
            body: JSON.stringify({ videoDetails: { title: "No Caps" } }),
          },
        }),
      },
    );
    expect(result).toBeNull();
  });
});

describe("youtubeTranscriptToMarkdown", () => {
  it("renders a titled transcript with metadata", () => {
    const md = youtubeTranscriptToMarkdown({
      videoId: "dQw4w9WgXcQ",
      title: "Test Video",
      author: "Test Channel",
      languageCode: "en",
      kind: "asr",
      text: "line one\nline two",
      segmentCount: 2,
      lengthSeconds: 75,
      description: "desc",
    });
    expect(md).toContain("# Test Video");
    expect(md).toContain("**Channel:** Test Channel");
    expect(md).toContain("en (auto-generated)");
    expect(md).toContain("1:15");
    expect(md).toContain("## Transcript");
    expect(md).toContain("line one\nline two");
    expect(md).toContain("## Description");
  });
});
