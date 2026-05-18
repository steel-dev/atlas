import type Anthropic from "@anthropic-ai/sdk";

const FAST_MODEL = "claude-haiku-4-5-20251001";
const WRITER_MODEL = "claude-sonnet-4-6";
const MAX_SOURCE_CHARS = 60_000;

export interface ResearchBrief {
  brief: string;
  sub_questions: string[];
}

export async function planBriefAndSubQuestions(opts: {
  anthropic: Anthropic;
  query: string;
  max_sub_questions: number;
  model?: string;
}): Promise<ResearchBrief> {
  const { anthropic, query, max_sub_questions, model } = opts;

  const system =
    "You decompose a user's research question into a focused research plan. " +
    "First, restate the question as a first-person research brief — what we are trying to find out and any implicit constraints (recency, scope, comparison points). " +
    "Then list the most-informative sub-questions whose answers, taken together, fully address the brief. " +
    "Sub-questions must be independent (no overlap) and each answerable from a few web sources.";

  const schema = {
    type: "object",
    properties: {
      brief: {
        type: "string",
        description: "First-person 1-3 sentence research brief.",
      },
      sub_questions: {
        type: "array",
        description: `Independent sub-questions, ${max_sub_questions} max.`,
        items: { type: "string" },
        minItems: 1,
        maxItems: max_sub_questions,
      },
    },
    required: ["brief", "sub_questions"],
  } as const;

  const response = await anthropic.messages.create({
    model: model ?? FAST_MODEL,
    max_tokens: 1024,
    system,
    tools: [
      {
        name: "submit_plan",
        description: "Submit the research brief and sub-questions.",
        input_schema: schema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_plan" },
    messages: [{ role: "user", content: `Research question: ${query}` }],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit research plan");
  const out = tool.input as ResearchBrief;
  return {
    brief: String(out.brief ?? "").trim(),
    sub_questions: Array.isArray(out.sub_questions)
      ? out.sub_questions.slice(0, max_sub_questions).map((s) => String(s).trim()).filter(Boolean)
      : [],
  };
}

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
}

export interface ReportOutput {
  markdown: string;
}

export async function writeReport(opts: {
  anthropic: Anthropic;
  brief: string;
  sources: CitedSource[];
  model?: string;
}): Promise<ReportOutput> {
  const { anthropic, brief, sources, model } = opts;

  const system =
    "You write a clear, comprehensive research report in Markdown. " +
    "Cite every factual claim with bracketed source numbers, e.g., [1] or [1, 3]. " +
    "Only include claims supported by the provided sources. " +
    "Structure: a one-paragraph intro, body sections with H2 headings as the material demands, then a final '## Sources' section listing each source as '[n] Title — URL'.";

  const sourceBlocks = sources
    .map((s) => {
      const excerpts = s.key_excerpts.length
        ? `\nKey excerpts:\n${s.key_excerpts.map((e) => `- "${e}"`).join("\n")}`
        : "";
      return `[${s.n}] ${s.title} — ${s.url}\n${s.summary}${excerpts}`;
    })
    .join("\n\n");

  const userPrompt =
    `Research brief: ${brief}\n\n` +
    `Sources (numbered):\n${sourceBlocks}\n\n` +
    `Write the report now. Aim for thorough coverage of the brief, with every claim grounded in a numbered source.`;

  const response = await anthropic.messages.create({
    model: model ?? WRITER_MODEL,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return { markdown: text };
}

export interface TaskBasis {
  field: string | null;
  quote: string;
  source_n: number;
  source_url: string;
  source_title: string;
}

export interface TaskOutput {
  data: unknown;
  basis: TaskBasis[];
}

export async function writeStructuredAnswer(opts: {
  anthropic: Anthropic;
  brief: string;
  sources: CitedSource[];
  output_schema: Record<string, unknown>;
  model?: string;
}): Promise<TaskOutput> {
  const { anthropic, brief, sources, output_schema, model } = opts;

  const system =
    "You answer a research question with STRUCTURED data matching the provided JSON schema. " +
    "Use ONLY the provided numbered sources as evidence. " +
    "For each non-empty field in your answer, attach a citation with: " +
    "(a) the JSON path of the field (e.g., 'company.name'), (b) a verbatim quote (≤300 chars) from a source, (c) the source number. " +
    "Omit fields you cannot ground in a source — do not invent values.";

  const wrappedSchema = {
    type: "object" as const,
    properties: {
      data: output_schema,
      basis: {
        type: "array",
        description: "Per-field citations with verbatim quotes from numbered sources.",
        items: {
          type: "object",
          properties: {
            field: {
              type: "string",
              description: "JSON path of the field being cited (e.g., 'company.founders.0.name').",
            },
            quote: {
              type: "string",
              description: "Verbatim quote (≤300 chars) from the source.",
            },
            source_n: {
              type: "integer",
              description: "Source number (1-indexed) from the provided list.",
              minimum: 1,
            },
          },
          required: ["quote", "source_n"],
        },
      },
    },
    required: ["data", "basis"],
  };

  const sourceBlocks = sources
    .map((s) => {
      const excerpts = s.key_excerpts.length
        ? `\nExcerpts:\n${s.key_excerpts.map((e) => `- "${e}"`).join("\n")}`
        : "";
      return `[${s.n}] ${s.title} — ${s.url}\n${s.summary}${excerpts}`;
    })
    .join("\n\n");

  const userPrompt =
    `Research brief: ${brief}\n\n` +
    `Sources (numbered, use ONLY these):\n${sourceBlocks}\n\n` +
    `Produce the structured answer now.`;

  const response = await anthropic.messages.create({
    model: model ?? WRITER_MODEL,
    max_tokens: 8192,
    system,
    tools: [
      {
        name: "submit_answer",
        description: "Submit the structured answer with per-field citations.",
        input_schema: wrappedSchema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_answer" },
    messages: [{ role: "user", content: userPrompt }],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit structured answer");

  const out = tool.input as {
    data: unknown;
    basis: Array<{ field?: string; quote?: string; source_n?: number }>;
  };
  const sourceByN = new Map<number, CitedSource>(sources.map((s) => [s.n, s]));
  const basis: TaskBasis[] = (Array.isArray(out.basis) ? out.basis : [])
    .map((b) => {
      const n = Number(b.source_n);
      const src = sourceByN.get(n);
      return {
        field: b.field ?? null,
        quote: String(b.quote ?? "").trim(),
        source_n: n,
        source_url: src?.url ?? "",
        source_title: src?.title ?? "",
      };
    })
    .filter((b) => b.quote && b.source_url);

  return { data: out.data, basis };
}
