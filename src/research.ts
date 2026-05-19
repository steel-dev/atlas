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

export interface ParsedClaim {
  text: string;
  source_n: number;
}

const SOURCES_HEADING_RE = /^#{1,3}\s*Sources\b/im;
const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

// Extract per-citation claims from a report markdown body. A "claim" is the
// sentence containing the [n] marker. Multi-source citations like [1, 2] yield
// one claim entry per source. The `## Sources` section is excluded.
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

export interface AssessmentResult {
  sufficient: boolean;
  gaps: string[];
  additional_queries: string[];
}

export async function assessCoverage(opts: {
  anthropic: Anthropic;
  brief: string;
  sub_questions: string[];
  sources: CitedSource[];
  rounds_remaining: number;
  max_additional_queries: number;
  model?: string;
}): Promise<AssessmentResult> {
  const {
    anthropic,
    brief,
    sub_questions,
    sources,
    rounds_remaining,
    max_additional_queries,
    model,
  } = opts;

  const system =
    "You audit the coverage of a research effort in progress. " +
    "Given the brief, sub-questions, and the summaries of sources gathered so far, decide whether the material is sufficient to write a thorough, well-cited report — or whether specific concrete gaps remain. " +
    "Be conservative: if every sub-question has 2+ corroborating sources and you cannot point to a specific unaddressed angle or contradiction, return sufficient=true. " +
    "Do NOT generate queries for hypothetical thoroughness or marginal completeness. Only emit queries that target a concrete missing fact, an unaddressed sub-question, or a disagreement that needs adjudication. " +
    `If you do emit queries, each must be specific (not generic) and at most ${max_additional_queries} total.`;

  const schema = {
    type: "object",
    properties: {
      sufficient: {
        type: "boolean",
        description: "True iff current sources suffice to write the report.",
      },
      gaps: {
        type: "array",
        description: "Concrete gaps in current coverage. Empty if sufficient.",
        items: { type: "string" },
      },
      additional_queries: {
        type: "array",
        description: `Specific search queries that would close the gaps. At most ${max_additional_queries}. Empty if sufficient.`,
        items: { type: "string" },
        maxItems: max_additional_queries,
      },
    },
    required: ["sufficient", "gaps", "additional_queries"],
  } as const;

  const sourceBlocks = sources.length
    ? sources
        .map((s) => `[${s.n}] ${s.title} — ${s.url}\n  ${s.summary}`)
        .join("\n\n")
    : "(none gathered yet)";

  const userPrompt =
    `Brief: ${brief}\n\n` +
    `Sub-questions:\n${sub_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
    `Sources so far:\n${sourceBlocks}\n\n` +
    `Rounds remaining after this one: ${rounds_remaining}.\n` +
    `Decide: sufficient, or specific concrete gaps + targeted queries?`;

  const response = await anthropic.messages.create({
    model: model ?? FAST_MODEL,
    max_tokens: 1024,
    system,
    tools: [
      {
        name: "submit_assessment",
        description: "Submit the coverage assessment.",
        input_schema: schema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_assessment" },
    messages: [{ role: "user", content: userPrompt }],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit assessment");
  const out = tool.input as AssessmentResult;
  const queries = Array.isArray(out.additional_queries)
    ? out.additional_queries
        .slice(0, max_additional_queries)
        .map((q) => String(q).trim())
        .filter(Boolean)
    : [];
  return {
    sufficient: Boolean(out.sufficient),
    gaps: Array.isArray(out.gaps)
      ? out.gaps.map((s) => String(s).trim()).filter(Boolean)
      : [],
    additional_queries: queries,
  };
}

export interface ClaimVerdict {
  supported: boolean;
  reason: string;
}

export async function verifyClaim(opts: {
  anthropic: Anthropic;
  claim: string;
  source: CitedSource;
  model?: string;
}): Promise<ClaimVerdict> {
  const { anthropic, claim, source, model } = opts;

  const system =
    "You verify whether a single claim from a research report is supported by a specific source. " +
    "Given the claim and the source's summary plus verbatim key excerpts, decide if the source plausibly states or directly implies the claim. " +
    "Be strict: vague-but-related sources do NOT count as support — the source must actually contain (or directly imply) the specific factual content. " +
    "Verbatim excerpts are the strongest evidence; the summary is supplementary.";

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
          "One-sentence justification, referencing the specific evidence (e.g., quoting an excerpt).",
      },
    },
    required: ["supported", "reason"],
  } as const;

  const excerpts = source.key_excerpts.length
    ? source.key_excerpts.map((e) => `- "${e}"`).join("\n")
    : "(none)";

  const userPrompt =
    `Claim from report: ${claim}\n\n` +
    `Source [${source.n}] ${source.title} — ${source.url}\n` +
    `Summary: ${source.summary}\n` +
    `Key excerpts:\n${excerpts}\n\n` +
    `Does this source support the claim?`;

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
    messages: [{ role: "user", content: userPrompt }],
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

export interface UnsupportedClaim {
  claim: string;
  source_n: number;
  reason: string;
}

export async function writeReport(opts: {
  anthropic: Anthropic;
  brief: string;
  sources: CitedSource[];
  unsupported_claims?: UnsupportedClaim[];
  model?: string;
}): Promise<ReportOutput> {
  const { anthropic, brief, sources, unsupported_claims, model } = opts;

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

  const retryBlock =
    unsupported_claims && unsupported_claims.length > 0
      ? "\n\nPREVIOUS DRAFT FAILED VERIFICATION on these claims. Revise the report — for each, either remove the claim, hedge it (only if the hedge itself is supportable), or replace with a claim that the cited source actually supports. Do NOT introduce new unsupported claims. Do NOT cite a source that does not address the claim.\n" +
        unsupported_claims
          .map(
            (u) =>
              `- [${u.source_n}] "${u.claim}" — verifier said: ${u.reason}`,
          )
          .join("\n")
      : "";

  const userPrompt =
    `Research brief: ${brief}\n\n` +
    `Sources (numbered):\n${sourceBlocks}\n\n` +
    `Write the report now. Aim for thorough coverage of the brief, with every claim grounded in a numbered source.` +
    retryBlock;

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
