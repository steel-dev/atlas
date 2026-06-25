const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID_RE = /^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})/;

const INNERTUBE_PLAYER_URL =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CLIENT = {
  clientName: "IOS",
  clientVersion: "20.10.4",
  deviceModel: "iPhone16,2",
  osName: "iPhone",
  osVersion: "18.3.2.22D82",
  hl: "en",
  gl: "US",
};
const INNERTUBE_USER_AGENT =
  "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)";
const PLAYER_TIMEOUT_MS = 15_000;
const TRANSCRIPT_TIMEOUT_MS = 15_000;
const DESCRIPTION_CAP = 2_000;

type FetchImpl = (
  input: string,
  init?: {
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface YoutubeTranscriptOptions {
  preferLang?: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal | undefined;
}

export interface YoutubeTranscript {
  videoId: string;
  title: string;
  author: string | null;
  languageCode: string;
  kind: "asr" | "manual";
  text: string;
  segmentCount: number;
  lengthSeconds: number | null;
  description: string | null;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (parsed.pathname === "/watch") {
      const v = parsed.searchParams.get("v") ?? "";
      return VIDEO_ID_RE.test(v) ? v : null;
    }
    const match = PATH_ID_RE.exec(parsed.pathname);
    if (match) return match[1] ?? null;
  }
  return null;
}

export function isYoutubeWatchUrl(url: string): boolean {
  return youtubeVideoId(url) !== null;
}

export async function fetchYoutubeTranscript(
  url: string,
  options: YoutubeTranscriptOptions = {},
): Promise<YoutubeTranscript | null> {
  const videoId = youtubeVideoId(url);
  if (!videoId) return null;
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const player = await fetchPlayerResponse(videoId, fetchImpl, options.signal);
  if (!player) return null;
  const track = pickCaptionTrack(player, options.preferLang ?? "en");
  if (!track?.baseUrl) return null;
  const text = await fetchTranscriptText(
    track.baseUrl,
    fetchImpl,
    options.signal,
  );
  const trimmed = text.trim();
  if (!trimmed) return null;
  const details = (player.videoDetails ?? {}) as Record<string, unknown>;
  const lengthRaw = Number(details.lengthSeconds);
  return {
    videoId,
    title: stringOr(details.title, `YouTube video ${videoId}`),
    author: nonEmpty(details.author),
    languageCode: track.languageCode ?? "und",
    kind: track.kind === "asr" ? "asr" : "manual",
    text: trimmed,
    segmentCount: trimmed.split("\n").filter(Boolean).length,
    lengthSeconds:
      Number.isFinite(lengthRaw) && lengthRaw > 0 ? lengthRaw : null,
    description: capDescription(nonEmpty(details.shortDescription)),
  };
}

export function youtubeTranscriptToMarkdown(t: YoutubeTranscript): string {
  const header: string[] = [`# ${t.title}`];
  if (t.author) header.push(`**Channel:** ${t.author}`);
  const lang =
    t.kind === "asr" ? `${t.languageCode} (auto-generated)` : t.languageCode;
  header.push(`**Transcript language:** ${lang}`);
  if (t.lengthSeconds)
    header.push(`**Length:** ${formatDuration(t.lengthSeconds)}`);
  header.push("**Source:** YouTube caption track");
  const parts = [header.join("\n"), "", "## Transcript", "", t.text];
  if (t.description) {
    parts.push("", "## Description", "", t.description);
  }
  return parts.join("\n");
}

async function fetchPlayerResponse(
  videoId: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<Record<string, any> | null> {
  const resp = await fetchImpl(INNERTUBE_PLAYER_URL, {
    method: "POST",
    signal: withTimeout(signal, PLAYER_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "user-agent": INNERTUBE_USER_AGENT,
      "accept-language": "en-US,en",
    },
    body: JSON.stringify({
      context: { client: INNERTUBE_CLIENT },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!resp.ok) throw new Error(`youtube player HTTP ${resp.status}`);
  try {
    return JSON.parse(await resp.text()) as Record<string, any>;
  } catch {
    return null;
  }
}

async function fetchTranscriptText(
  baseUrl: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<string> {
  const direct = await requestTimedText(baseUrl, fetchImpl, signal);
  const parsed = parseTranscriptBody(direct);
  if (parsed) return parsed;
  const json = await requestTimedText(
    appendQuery(baseUrl, "fmt", "json3"),
    fetchImpl,
    signal,
  );
  return parseTranscriptBody(json);
}

async function requestTimedText(
  url: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<string> {
  const resp = await fetchImpl(url, {
    signal: withTimeout(signal, TRANSCRIPT_TIMEOUT_MS),
    headers: {
      "user-agent": INNERTUBE_USER_AGENT,
      "accept-language": "en-US,en",
    },
  });
  if (!resp.ok) throw new Error(`youtube timedtext HTTP ${resp.status}`);
  return resp.text();
}

export function pickCaptionTrack(
  player: Record<string, any>,
  preferLang = "en",
): CaptionTrack | null {
  const tracks: CaptionTrack[] =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const lang = preferLang.toLowerCase();
  const inLang = tracks.filter((t) =>
    (t.languageCode ?? "").toLowerCase().startsWith(lang),
  );
  const manual = tracks.filter((t) => t.kind !== "asr");
  return (
    inLang.find((t) => t.kind !== "asr") ??
    inLang[0] ??
    manual[0] ??
    tracks[0] ??
    null
  );
}

export function parseTranscriptBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) return parseTimedTextJson(trimmed);
  const fromText = parseTagLines(trimmed, "text");
  if (fromText) return fromText;
  return parseTagLines(trimmed, "p");
}

function parseTagLines(xml: string, tag: "text" | "p"): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const lines: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const inner = (match[1] ?? "").replace(/<[^>]+>/g, "");
    const decoded = decodeEntities(inner).replace(/\s+/g, " ").trim();
    if (decoded) lines.push(decoded);
  }
  return lines.join("\n");
}

function parseTimedTextJson(raw: string): string {
  let data: { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
  try {
    data = JSON.parse(raw);
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const event of data.events ?? []) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

function decodeEntities(s: string): string {
  const once = decodeEntitiesOnce(s);
  if (once === s || !once.includes("&")) return once;
  return decodeEntitiesOnce(once);
}

function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function fromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function appendQuery(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${key}=${value}`;
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function capDescription(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > DESCRIPTION_CAP
    ? `${trimmed.slice(0, DESCRIPTION_CAP)}…`
    : trimmed;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
