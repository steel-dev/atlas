import { looksBlocked } from "./steel.js";

const USER_AGENT =
  "Mozilla/5.0 (compatible; AtlasResearchBot/0.1; +https://github.com/steel-experiments/atlas)";
const MAX_PLAIN_INPUT_CHARS = 1_000_000;

export interface PlainPageMetadata {
  content_type: string;
  raw_chars: number;
  raw_truncated: boolean;
  markdown_chars: number;
  extraction_notes: string[];
}

export interface PlainPage {
  markdown: string;
  title: string | null;
  metadata: PlainPageMetadata;
}

export type PlainPageOutcome =
  | { ok: true; page: PlainPage }
  | { ok: false; reason: string };

export async function fetchPlainPage(opts: {
  url: string;
  signal?: AbortSignal;
}): Promise<PlainPageOutcome> {
  let response: Response;
  try {
    response = await fetch(opts.url, {
      signal: opts.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/plain,text/markdown,application/json,text/csv,application/xml;q=0.8,*/*;q=0.3",
      },
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!isPlainReadableContentType(contentType)) {
    return {
      ok: false,
      reason: `Browser-rendered fetch required for content-type: ${contentType || "unknown"}`,
    };
  }

  const rawBody = await response.text();
  const rawTruncated = rawBody.length > MAX_PLAIN_INPUT_CHARS;
  const raw = rawBody.slice(0, MAX_PLAIN_INPUT_CHARS);
  if (!raw.trim()) return { ok: false, reason: "Empty body" };
  if (looksBlocked(raw)) return { ok: false, reason: "Blocked or challenge page" };

  const page = textToMarkdown(raw);
  const extractionNotes = ["Fetched as readable text without browser rendering."];
  if (rawTruncated) {
    extractionNotes.push(
      `Plain fetch input was truncated at ${MAX_PLAIN_INPUT_CHARS.toLocaleString()} chars before extraction.`,
    );
  }
  page.metadata = {
    content_type: contentType || "unknown",
    raw_chars: rawBody.length,
    raw_truncated: rawTruncated,
    markdown_chars: page.markdown.length,
    extraction_notes: extractionNotes,
  };

  return { ok: true, page };
}

function isPlainReadableContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("text/plain") ||
    lower.includes("text/markdown") ||
    lower.includes("text/csv") ||
    lower.includes("application/json") ||
    lower.includes("application/xml") ||
    lower.includes("application/x-ndjson")
  );
}

function textToMarkdown(raw: string): PlainPage {
  const markdown = normalizeWhitespace(raw);
  const title =
    markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.replace(/^#+\s*/, "")
      .slice(0, 160) ?? null;
  return { markdown, title, metadata: emptyPlainMetadata() };
}

function emptyPlainMetadata(): PlainPageMetadata {
  return {
    content_type: "unknown",
    raw_chars: 0,
    raw_truncated: false,
    markdown_chars: 0,
    extraction_notes: [],
  };
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const __testing = {
  textToMarkdown,
};
