import type Anthropic from "@anthropic-ai/sdk";

export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const WRITER_MODEL = "claude-sonnet-4-6";
const WRITER_MARKDOWN_BUDGET = 20_000;

export interface CitedSource {
  n: number;
  url: string;
  title: string;
  sub_question: string;
}

export interface ReportOutput {
  markdown: string;
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

  const sourceBlocks = sources
    .map((s) => {
      const raw = source_texts.get(s.n) ?? "";
      const rawBlock = raw
        ? `\nPage content (truncated to ${WRITER_MARKDOWN_BUDGET.toLocaleString()} chars):\n${raw.slice(0, WRITER_MARKDOWN_BUDGET)}`
        : "\n(No page content available.)";
      return `[${s.n}] ${s.title} — ${s.url}\nSub-question: ${s.sub_question || "(unspecified)"}${rawBlock}`;
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
