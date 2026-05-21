import type Anthropic from "@anthropic-ai/sdk";

export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const WRITER_MODEL = "claude-sonnet-4-6";
const MAX_SOURCE_CHARS = 100_000;
const WRITER_MARKDOWN_BUDGET = 20_000;
const VERIFY_MARKDOWN_BUDGET = 20_000;

export interface PageSummary {
  summary: string;
  key_excerpts: string[];
  is_relevant: boolean;
}

export async function summarizeWebpage(opts: {
  anthropic: Anthropic;
  markdown: string;
  url: string;
  title: string | null;
  sub_question: string;
  model?: string;
}): Promise<PageSummary> {
  const { anthropic, markdown, url, title, sub_question, model } = opts;

  const system =
    "You read one web page and extract what it says about a specific sub-question. " +
    "Return a tight summary (3-5 sentences) plus up to 4 verbatim key excerpts (each ≤200 chars). " +
    "If the page is unrelated to the sub-question, set is_relevant=false and return empty arrays.";

  const schema = {
    type: "object",
    properties: {
      summary: { type: "string", description: "3-5 sentence summary tied to the sub-question." },
      key_excerpts: {
        type: "array",
        description: "Verbatim quotes from the source supporting the summary.",
        items: { type: "string", maxLength: 240 },
        maxItems: 4,
      },
      is_relevant: { type: "boolean", description: "True if page actually addresses the sub-question." },
    },
    required: ["summary", "key_excerpts", "is_relevant"],
  } as const;

  const userPrompt =
    `Sub-question: ${sub_question}\n` +
    `Source: ${title ?? "(no title)"} — ${url}\n\n` +
    `Page content:\n${markdown.slice(0, MAX_SOURCE_CHARS)}`;

  const response = await anthropic.messages.create({
    model: model ?? FAST_MODEL,
    max_tokens: 1024,
    system,
    tools: [
      {
        name: "submit_summary",
        description: "Submit the page summary, key excerpts, and relevance flag.",
        input_schema: schema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_summary" },
    messages: [{ role: "user", content: userPrompt }],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit page summary");
  const out = tool.input as PageSummary;
  return {
    summary: String(out.summary ?? "").trim(),
    key_excerpts: Array.isArray(out.key_excerpts) ? out.key_excerpts.map((s) => String(s).trim()) : [],
    is_relevant: Boolean(out.is_relevant ?? true),
  };
}

export interface CitedSource {
  n: number;
  url: string;
  title: string;
  summary: string;
  key_excerpts: string[];
  sub_question: string;
}

export interface ParsedClaim {
  text: string;
  source_n: number;
}

const SOURCES_HEADING_RE = /^#{1,3}\s*Sources\b/im;
const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export function parseCitations(markdown: string): ParsedClaim[] {
  const sourcesMatch = markdown.match(SOURCES_HEADING_RE);
  const body =
    sourcesMatch && sourcesMatch.index !== undefined
      ? markdown.slice(0, sourcesMatch.index)
      : markdown;

  const claims: ParsedClaim[] = [];
  CITATION_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(body)) !== null) {
    const numbers = m[1]
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numbers.length === 0) continue;

    const sentence = extractSentenceAround(body, m.index, m.index + m[0].length);
    if (!sentence) continue;

    for (const n of numbers) {
      claims.push({ text: sentence, source_n: n });
    }
  }

  return claims;
}

function extractSentenceAround(
  text: string,
  citationStart: number,
  citationEnd: number,
): string {
  let start = 0;
  for (let i = citationStart - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n" && i > 0 && text[i - 1] === "\n") {
      start = i + 1;
      break;
    }
    if (
      (ch === "." || ch === "!" || ch === "?") &&
      i + 1 < text.length &&
      (text[i + 1] === " " || text[i + 1] === "\n")
    ) {
      start = i + 2;
      break;
    }
  }

  let end = text.length;
  for (let i = citationEnd; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      end = i;
      break;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      end = i + 1;
      break;
    }
    if (ch === "\n") {
      end = i;
      break;
    }
  }

  return text.slice(start, end).trim();
}

export interface ClaimVerdict {
  supported: boolean;
  reason: string;
}

export async function verifyClaim(opts: {
  anthropic: Anthropic;
  claim: string;
  source: CitedSource;
  /** Raw page markdown for the source. Used as the GROUND TRUTH for the
   *  verdict — summary + excerpts come from the same Haiku that read the page
   *  during the scout phase, so verifying against them alone is circular.
   *  Truncated to VERIFY_MARKDOWN_BUDGET chars. */
  raw_text?: string;
  model?: string;
}): Promise<ClaimVerdict> {
  const { anthropic, claim, source, raw_text, model } = opts;

  const system =
    "You verify whether a single claim from a research report is supported by a specific source. " +
    "You will see (a) the page's raw content, which is the GROUND TRUTH; (b) a summary and verbatim key excerpts, which are convenience hints — NOT proof. " +
    "Decide whether the page actually contains, or directly implies, the specific factual content of the claim. " +
    "Be strict: vague-but-related content does NOT count as support. If the summary or excerpts disagree with the raw page, trust the raw page. " +
    "When the raw page is absent, fall back to summary + excerpts but be more conservative.";

  const schema = {
    type: "object",
    properties: {
      supported: {
        type: "boolean",
        description: "True iff the source supports the claim.",
      },
      reason: {
        type: "string",
        description:
          "One-sentence justification, quoting the specific phrase from the raw page (or excerpt) that supports — or fails to support — the claim.",
      },
    },
    required: ["supported", "reason"],
  } as const;

  const excerpts = source.key_excerpts.length
    ? source.key_excerpts.map((e) => `- "${e}"`).join("\n")
    : "(none)";

  const rawBlock = raw_text
    ? `\n\nPage content (GROUND TRUTH, truncated to ${VERIFY_MARKDOWN_BUDGET.toLocaleString()} chars):\n${raw_text.slice(0, VERIFY_MARKDOWN_BUDGET)}`
    : "\n\n(Raw page content not available — verify against summary + excerpts only.)";

  // Source-first ordering so that N claims against the same source share a
  // cacheable prefix. cache_control breakpoint on the source block; the claim
  // is the only thing that varies between calls and lives after.
  const sourceBlock =
    `Source [${source.n}] ${source.title} — ${source.url}\n` +
    `Summary (hint): ${source.summary}\n` +
    `Key excerpts (hint):\n${excerpts}` +
    rawBlock;
  const claimBlock = `\n\nClaim from report: ${claim}\n\nDoes the source support the claim?`;

  const response = await anthropic.messages.create({
    model: model ?? FAST_MODEL,
    max_tokens: 512,
    system,
    tools: [
      {
        name: "submit_verdict",
        description: "Submit the support verdict and a short justification.",
        input_schema: schema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_verdict" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: sourceBlock,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: claimBlock },
        ],
      },
    ],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit verdict");
  const out = tool.input as ClaimVerdict;
  return {
    supported: Boolean(out.supported),
    reason: String(out.reason ?? "").trim(),
  };
}

export interface ReportOutput {
  markdown: string;
}

export async function writeReport(opts: {
  anthropic: Anthropic;
  query: string;
  sources: CitedSource[];
  source_texts: Map<number, string>;
  lead_notes?: string;
  model?: string;
}): Promise<ReportOutput> {
  const { anthropic, query, sources, source_texts, lead_notes, model } = opts;

  const system =
    "You write a clear, comprehensive research report in Markdown answering the user's question. " +
    "Cite every factual claim with bracketed source numbers, e.g., [1] or [1, 3]. " +
    "Only include claims supported by the provided sources — the per-source summary, the verbatim key excerpts, AND the (truncated) raw page content given below. " +
    "Prefer concrete, specific claims grounded in the raw content over generic restatements of the summary. " +
    "Structure: a one-paragraph intro, body sections with H2 headings as the material demands, then a final '## Sources' section listing each source as '[n] Title — URL'.";

  const sourceBlocks = sources
    .map((s) => {
      const excerpts = s.key_excerpts.length
        ? `\nKey excerpts:\n${s.key_excerpts.map((e) => `- "${e}"`).join("\n")}`
        : "";
      const raw = source_texts.get(s.n) ?? "";
      const rawBlock = raw
        ? `\nFull page content (truncated to ${WRITER_MARKDOWN_BUDGET.toLocaleString()} chars):\n${raw.slice(0, WRITER_MARKDOWN_BUDGET)}`
        : "";
      return `[${s.n}] ${s.title} — ${s.url}\nSub-question: ${s.sub_question || "(unspecified)"}\nSummary: ${s.summary}${excerpts}${rawBlock}`;
    })
    .join("\n\n---\n\n");

  const notesBlock = lead_notes
    ? `\n\nResearch lead's notes on what was found (use as guidance, not as facts to cite):\n${lead_notes}`
    : "";

  const stableBlock =
    `Research question: ${query}\n\n` +
    `Sources (numbered):\n${sourceBlocks}`;
  const instructionBlock =
    `\n\nWrite the report now. Aim for thorough coverage of the question, with every claim grounded in a numbered source.` +
    notesBlock;

  const response = await anthropic.messages.create({
    model: model ?? WRITER_MODEL,
    max_tokens: 16384,
    system,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: stableBlock,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: instructionBlock },
        ],
      },
    ],
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return { markdown: text };
}
