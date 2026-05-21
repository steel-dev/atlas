import type Anthropic from "@anthropic-ai/sdk";

export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const WRITER_MODEL = "claude-sonnet-4-6";
const MAX_SOURCE_CHARS = 100_000;
const WRITER_MARKDOWN_BUDGET = 20_000;

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

const VERIFY_MARKDOWN_BUDGET = 20_000;

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
  // cacheable prefix. The cache_control breakpoint sits on the source block;
  // the claim is the only thing that varies between calls and lives after.
  // Haiku's minimum cacheable prefix is ~4096 tokens — small pages won't
  // cache, but cache_control is silently ignored in that case (no error).
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

export interface UnsupportedClaim {
  claim: string;
  source_n: number;
  reason: string;
}

export interface CritiqueResult {
  needs_revision: boolean;
  issues: string[];
}

export async function critiqueDraft(opts: {
  anthropic: Anthropic;
  brief: string;
  sub_questions: string[];
  markdown: string;
  sources: CitedSource[];
  model?: string;
}): Promise<CritiqueResult> {
  const { anthropic, brief, sub_questions, markdown, sources, model } = opts;

  const system =
    "You are a strict peer reviewer of a research-report draft. " +
    "Read the draft against the brief and sub-questions; identify concrete substantive issues — NOT style/grammar nits. " +
    "Substantive issues include: an unaddressed (or barely addressed) sub-question; a claim that hedges without needing to; a claim that needs hedging but doesn't; a contradiction across sources the report ignored; a surface restatement where the source content actually offered more specific information; off-brief tangents; missing recency or scope context implied by the brief. " +
    "Return needs_revision=true ONLY if you can list at least one issue that, if fixed, would meaningfully improve the report. If the report adequately covers the brief with grounded specifics, return needs_revision=false with empty issues. " +
    "At most 5 issues. Each issue must be actionable — name what is missing or wrong AND what concrete fix would address it.";

  const schema = {
    type: "object",
    properties: {
      needs_revision: { type: "boolean" },
      issues: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
      },
    },
    required: ["needs_revision", "issues"],
  } as const;

  const sourceBlocks = sources.length
    ? sources
        .map((s) => `[${s.n}] ${s.title} — ${s.url}\n  ${s.summary}`)
        .join("\n\n")
    : "(none)";

  // Stable prefix (brief + sub-questions + sources) shared across attempts 1
  // and 2; only the draft markdown changes between calls. cache_control on
  // the stable block lets attempt 2 read what attempt 1 wrote.
  const stableBlock =
    `Brief: ${brief}\n\n` +
    `Sub-questions:\n${sub_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
    `Sources used (numbered):\n${sourceBlocks}`;
  const draftBlock =
    `\n\nDraft report:\n\n${markdown}\n\n` +
    `Critique strictly — substantive issues only, max 5.`;

  const response = await anthropic.messages.create({
    model: model ?? WRITER_MODEL,
    max_tokens: 2048,
    system,
    tools: [
      {
        name: "submit_critique",
        description: "Submit the critique.",
        input_schema: schema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_critique" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: stableBlock,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: draftBlock },
        ],
      },
    ],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit critique");
  const out = tool.input as CritiqueResult;
  return {
    needs_revision: Boolean(out.needs_revision),
    issues: Array.isArray(out.issues)
      ? out.issues.map((s) => String(s).trim()).filter(Boolean).slice(0, 5)
      : [],
  };
}

export async function writeReport(opts: {
  anthropic: Anthropic;
  brief: string;
  sources: CitedSource[];
  source_texts?: Map<number, string>;
  unsupported_claims?: UnsupportedClaim[];
  critique_issues?: string[];
  model?: string;
}): Promise<ReportOutput> {
  const {
    anthropic,
    brief,
    sources,
    source_texts,
    unsupported_claims,
    critique_issues,
    model,
  } = opts;

  const system =
    "You write a clear, comprehensive research report in Markdown. " +
    "Cite every factual claim with bracketed source numbers, e.g., [1] or [1, 3]. " +
    "Only include claims supported by the provided sources — the per-source summary, the verbatim key excerpts, AND the (truncated) raw page content given below. " +
    "Prefer concrete, specific claims grounded in the raw content over generic restatements of the summary. " +
    "Structure: a one-paragraph intro, body sections with H2 headings as the material demands, then a final '## Sources' section listing each source as '[n] Title — URL'.";

  const sourceBlocks = sources
    .map((s) => {
      const excerpts = s.key_excerpts.length
        ? `\nKey excerpts:\n${s.key_excerpts.map((e) => `- "${e}"`).join("\n")}`
        : "";
      const raw = source_texts?.get(s.n) ?? "";
      const rawBlock = raw
        ? `\nFull page content (truncated to ${WRITER_MARKDOWN_BUDGET.toLocaleString()} chars):\n${raw.slice(0, WRITER_MARKDOWN_BUDGET)}`
        : "";
      return `[${s.n}] ${s.title} — ${s.url}\nSub-question: ${s.sub_question || "(unspecified)"}\nSummary: ${s.summary}${excerpts}${rawBlock}`;
    })
    .join("\n\n---\n\n");

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

  const critiqueBlock =
    critique_issues && critique_issues.length > 0
      ? "\n\nPEER REVIEW flagged these substantive issues — address each in the rewrite. Use the raw page content above to ground concrete fixes; do NOT add new unsupported claims:\n" +
        critique_issues.map((s) => `- ${s}`).join("\n")
      : "";

  // Stable prefix (brief + sources) shared across retry attempts; the
  // instruction tail varies when unsupported_claims / critique_issues land.
  // cache_control on the stable block makes attempt 2 (and the sectioned-
  // writer fallback path) reuse the prefix attempt 1 wrote.
  const stableBlock =
    `Research brief: ${brief}\n\n` +
    `Sources (numbered):\n${sourceBlocks}`;
  const instructionBlock =
    `\n\nWrite the report now. Aim for thorough coverage of the brief, with every claim grounded in a numbered source.` +
    retryBlock +
    critiqueBlock;

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

// ----------------------------------------------------------------------------
// Section-by-section writer
//
// Single-pass writeReport above hands the Sonnet writer ~all sources × 20K raw
// chars in one shot — easy to overwhelm, and the writer ends up doing internal
// retrieval over its own context (a common hallucination vector).
//
// Sectioned writer splits that into:
//   1. planOutline    — Sonnet decides section structure from summaries only.
//   2. writeSection   — per section, the writer sees ONLY that section's
//                       sources at full raw fidelity. Parallel across sections.
//   3. (research.ts assembles them and appends the Sources list.)
//
// The retry path (attempt > 1) keeps using single-pass writeReport so the
// rewrite can address per-claim verify failures + critique issues in one go.
// ----------------------------------------------------------------------------

export interface OutlineSection {
  title: string;
  source_ns: number[];
  notes: string;
}

export interface ReportOutline {
  sections: OutlineSection[];
}

export async function planOutline(opts: {
  anthropic: Anthropic;
  brief: string;
  sub_questions: string[];
  sources: CitedSource[];
  model?: string;
}): Promise<ReportOutline> {
  const { anthropic, brief, sub_questions, sources, model } = opts;

  const system =
    "You plan the section structure of a research report. " +
    "Given the brief, the sub-questions, and the source pool (summaries + key excerpts only — no raw text yet), produce an ordered list of 3-6 sections that together fully address the brief. " +
    "Constraints: " +
    "(a) Each section title is concrete and specific, NOT generic ('Background', 'Introduction' are bad — 'Pre-SQLite Durable Object storage model' is good). " +
    "(b) Sections do not overlap — each covers a distinct angle. " +
    "(c) Order sections by reader flow (context → main findings → caveats/tradeoffs typically). " +
    "(d) For each section, list the source [n] numbers most relevant. A source can appear in 1-2 sections but try to anchor each primarily in one. " +
    "(e) Every source [n] in the pool must appear in at least one section. " +
    "(f) Every sub-question should be addressable from the sections collectively. " +
    "(g) Each section has a 1-2 sentence `notes` field giving the section writer concrete guidance on what to cover.";

  const validNs = sources.map((s) => s.n);
  const schema = {
    type: "object",
    properties: {
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "H2 heading text (≤10 words). Concrete and specific.",
            },
            source_ns: {
              type: "array",
              items: { type: "integer", minimum: 1 },
              minItems: 1,
              description: "Source [n] numbers relevant to this section.",
            },
            notes: {
              type: "string",
              description:
                "1-2 sentences guiding the section writer on what to cover.",
            },
          },
          required: ["title", "source_ns", "notes"],
        },
      },
    },
    required: ["sections"],
  } as const;

  const sourceBlocks = sources
    .map((s) => {
      const excerpts = s.key_excerpts.length
        ? `\n  Key excerpts:\n${s.key_excerpts.map((e) => `    - "${e}"`).join("\n")}`
        : "";
      return `[${s.n}] ${s.title} — ${s.url}\n  Sub-question: ${s.sub_question || "(unspecified)"}\n  Summary: ${s.summary}${excerpts}`;
    })
    .join("\n\n");

  const userPrompt =
    `Brief: ${brief}\n\n` +
    `Sub-questions:\n${sub_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n` +
    `Source pool (${sources.length} sources, summaries only):\n${sourceBlocks}\n\n` +
    `Plan the section structure. Valid source numbers: ${validNs.join(", ")}.`;

  const response = await anthropic.messages.create({
    model: model ?? WRITER_MODEL,
    max_tokens: 2048,
    system,
    tools: [
      {
        name: "submit_outline",
        description: "Submit the report section outline.",
        input_schema: schema as unknown as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "submit_outline" },
    messages: [{ role: "user", content: userPrompt }],
  });

  const tool = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!tool) throw new Error("LLM did not submit outline");
  const out = tool.input as {
    sections?: Array<{ title?: string; source_ns?: number[]; notes?: string }>;
  };
  const raw = Array.isArray(out.sections) ? out.sections : [];
  const validSet = new Set(validNs);

  const sections: OutlineSection[] = [];
  for (const s of raw) {
    const title = String(s.title ?? "").trim();
    if (!title) continue;
    const source_ns = Array.isArray(s.source_ns)
      ? s.source_ns
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isFinite(n) && validSet.has(n))
      : [];
    if (source_ns.length === 0) continue;
    sections.push({
      title,
      source_ns,
      notes: String(s.notes ?? "").trim(),
    });
  }

  return { sections };
}

export async function writeSection(opts: {
  anthropic: Anthropic;
  brief: string;
  section: OutlineSection;
  section_index: number;
  section_total: number;
  prior_section_titles: string[];
  upcoming_section_titles: string[];
  sources_for_section: CitedSource[];
  source_texts: Map<number, string>;
  model?: string;
}): Promise<{ markdown: string }> {
  const {
    anthropic,
    brief,
    section,
    section_index,
    section_total,
    prior_section_titles,
    upcoming_section_titles,
    sources_for_section,
    source_texts,
    model,
  } = opts;

  const system =
    "You write ONE section of a research report in Markdown. " +
    "Cite every factual claim with bracketed source numbers, e.g., [1] or [1, 3]. " +
    "Only include claims supported by the sources listed below — the per-source summary, the verbatim key excerpts, AND the (truncated) raw page content. " +
    "Prefer concrete, specific claims grounded in the raw content over generic restatements of the summary. " +
    "Structure: start with the H2 heading exactly as given, then 2-4 body paragraphs (or a short list/table if appropriate). " +
    "Do NOT include a Sources list, intro, or other sections — only THIS section's heading and body. " +
    "Do NOT repeat material that prior sections cover. Stay scoped to this section's notes.";

  const sourceBlocks = sources_for_section
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

  const priorBlock = prior_section_titles.length
    ? `\nPrior sections (already covered — don't repeat):\n${prior_section_titles.map((t) => `- ${t}`).join("\n")}`
    : "";
  const upcomingBlock = upcoming_section_titles.length
    ? `\nUpcoming sections (will cover separately — don't preempt):\n${upcoming_section_titles.map((t) => `- ${t}`).join("\n")}`
    : "";

  const userPrompt =
    `Research brief: ${brief}\n\n` +
    `Section ${section_index} of ${section_total}.\n` +
    `Heading (use exactly): ## ${section.title}\n` +
    `Section notes: ${section.notes}` +
    priorBlock +
    upcomingBlock +
    `\n\nSources for this section (numbered as in the final report):\n${sourceBlocks}\n\n` +
    `Write this section now — only the H2 heading and body. No Sources list.`;

  const response = await anthropic.messages.create({
    model: model ?? WRITER_MODEL,
    max_tokens: 4096,
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

export function assembleSectionedReport(
  sources: CitedSource[],
  section_markdowns: string[],
): string {
  const body = section_markdowns.map((s) => s.trim()).filter(Boolean).join("\n\n");
  const sourcesList =
    "## Sources\n" +
    sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");
  return `${body}\n\n${sourcesList}`;
}
