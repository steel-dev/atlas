import type Anthropic from "@anthropic-ai/sdk";

export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const WRITER_MODEL = "claude-sonnet-4-6";
const WRITER_MAX_SOURCE_CHARS = 60_000;
const WRITER_TOTAL_SOURCE_CHARS = 240_000;
const WRITER_MIN_SOURCE_CHARS = 4_000;
const MAX_HEADING_OUTLINE_CHARS = 4_000;

export interface CitedSource {
  n: number;
  url: string;
  title: string;
}

export interface ReportOutput {
  markdown: string;
}

function markdownHeadingOutline(markdown: string): string {
  const headings = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,4}\s+\S/.test(line));

  if (headings.length === 0) return "";
  const outline = headings.join("\n").slice(0, MAX_HEADING_OUTLINE_CHARS);
  return `Document heading outline:\n${outline}\n\n`;
}

function packSourceMarkdown(markdown: string, budget: number): string {
  if (markdown.length <= budget) return markdown;

  const outline = markdownHeadingOutline(markdown);
  const truncation = "\n\n[... truncated source page ...]";
  const contentBudget = Math.max(
    WRITER_MIN_SOURCE_CHARS,
    budget - outline.length - truncation.length,
  );
  return `${outline}${markdown.slice(0, contentBudget)}${truncation}`.slice(
    0,
    budget,
  );
}

export async function writeReport(opts: {
  anthropic: Anthropic;
  query: string;
  sources: CitedSource[];
  source_texts: Map<number, string>;
  model?: string;
  signal?: AbortSignal;
}): Promise<ReportOutput> {
  const { anthropic, query, sources, source_texts, model, signal } = opts;

  const system =
    "You write a clear, comprehensive research report in Markdown answering the user's question. " +
    "Cite every factual claim with bracketed source numbers, e.g., [1] or [1, 3]. " +
    "Only include claims supported by the provided source pages. " +
    "Prefer concrete, specific claims grounded in the page content over vague generalities. " +
    "Structure: a one-paragraph intro, body sections with H2 headings as the material demands, then a final '## Sources' section listing each source as '[n] Title — URL'.";

  const sourceBudget = Math.max(
    WRITER_MIN_SOURCE_CHARS,
    Math.min(
      WRITER_MAX_SOURCE_CHARS,
      Math.floor(WRITER_TOTAL_SOURCE_CHARS / Math.max(1, sources.length)),
    ),
  );

  const sourceBlocks = sources
    .map((s) => {
      const raw = source_texts.get(s.n) ?? "";
      const packed = raw ? packSourceMarkdown(raw, sourceBudget) : "";
      const rawBlock = raw
        ? `\nPage content (packed to ${sourceBudget.toLocaleString()} chars):\n${packed}`
        : "\n(No page content available.)";
      return `[${s.n}] ${s.title} — ${s.url}${rawBlock}`;
    })
    .join("\n\n---\n\n");

  const stableBlock =
    `Research question: ${query}\n\n` +
    `Sources (numbered):\n${sourceBlocks}`;
  const instructionBlock =
    `\n\nWrite the report now. Aim for thorough coverage of the question, with every claim grounded in a numbered source.`;

  const response = await anthropic.messages.create(
    {
      model: model ?? WRITER_MODEL,
      max_tokens: 16384,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
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
    },
    { signal },
  );

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return { markdown: text };
}
