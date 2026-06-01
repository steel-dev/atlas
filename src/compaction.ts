import type {
  ModelAssistantBlock,
  ModelMessage,
  ModelToolResult,
} from "./model.js";
import type { ResearchCtx } from "./runtime.js";

/** Rough chars-per-token used to estimate context size without an extra
 *  tokenizer dependency. A 200k-token trigger against a much larger context
 *  window leaves ample headroom, so this approximation is safe. */
const CHARS_PER_TOKEN = 4;
/** Cap on the progress-note output. The raw evidence stays in the source
 *  store, so the note only needs to carry reasoning state, not page text. */
const MAX_SUMMARY_TOKENS = 2_048;
/** Per-block cap when rendering the folded region for the summarizer, to keep
 *  one giant tool result (e.g. a 100k JSON blob) from dominating the prompt. */
const RENDER_BLOCK_CHAR_CAP = 16_000;
const RENDER_THINKING_CHAR_CAP = 4_000;
const RENDER_TOOL_INPUT_CHAR_CAP = 1_000;
/** Don't pay for a summarization round-trip unless the folded region is large
 *  enough to be worth reclaiming. */
const MIN_FOLD_TOKENS = 2_000;

export const COMPACTION_SYSTEM_PROMPT =
  "You compress the older portion of a research agent's transcript into a faithful progress note so the agent can keep working within a smaller context. " +
  "Preserve concrete facts, names, numbers, dates, and the source_id that established each one. Capture the current best hypothesis, what has been ruled out, dead-end queries or URLs already tried, and the open gaps that still need work. " +
  "Be strictly faithful: never invent facts, sources, or source_ids, and never claim something was found that was not. Do not restate raw page text — reference evidence by source_id. Write tight prose or bullet points with no preamble.";

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function blockChars(block: ModelAssistantBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length;
    case "redacted_thinking":
      return block.data.length;
    case "tool_call":
      return block.name.length + JSON.stringify(block.input ?? {}).length;
  }
}

function toolResultChars(result: ModelToolResult): number {
  return result.content.length;
}

export function estimateMessageTokens(message: ModelMessage): number {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return estimateTextTokens(message.content);
    }
    const chars = message.content.reduce(
      (sum, result) => sum + toolResultChars(result),
      0,
    );
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  const chars = message.content.reduce(
    (sum, block) => sum + blockChars(block),
    0,
  );
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

function planCutIndex(messages: ModelMessage[], keepTokens: number): number {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 1) return -1;

  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (acc + tokens > keepTokens && cut <= lastAssistantIdx) break;
    acc += tokens;
    cut = i;
  }

  // Always keep at least the final assistant turn verbatim.
  if (cut > lastAssistantIdx) cut = lastAssistantIdx;
  // Snap the tail boundary onto an assistant message.
  while (cut >= 1 && messages[cut].role !== "assistant") cut--;
  return cut;
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} chars omitted]`;
}

function renderFoldedForSummary(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        if (message.content.trim()) {
          parts.push(`NOTE: ${cap(message.content, RENDER_BLOCK_CHAR_CAP)}`);
        }
        continue;
      }
      for (const result of message.content) {
        const label = result.is_error ? "TOOL RESULT (error)" : "TOOL RESULT";
        parts.push(`${label}: ${cap(result.content, RENDER_BLOCK_CHAR_CAP)}`);
      }
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        parts.push(`ASSISTANT: ${cap(block.text, RENDER_BLOCK_CHAR_CAP)}`);
      } else if (block.type === "thinking" && block.thinking.trim()) {
        parts.push(
          `ASSISTANT (thinking): ${cap(block.thinking, RENDER_THINKING_CHAR_CAP)}`,
        );
      } else if (block.type === "tool_call") {
        const input = cap(
          JSON.stringify(block.input ?? {}),
          RENDER_TOOL_INPUT_CHAR_CAP,
        );
        parts.push(`ASSISTANT called ${block.name}(${input})`);
      }
    }
  }
  return parts.join("\n\n");
}

export function buildSourceIndex(ctx: ResearchCtx): string {
  if (ctx.store.fetchedSources.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of ctx.store.fetchedSources) {
    const key = source.sourceId ?? source.url;
    if (seen.has(key)) continue;
    seen.add(key);
    const handle = source.sourceId ? `${source.sourceId} — ` : "";
    const title = source.title ? `${source.title} ` : "";
    lines.push(`- ${handle}${title}(${source.url})`);
  }
  return (
    "Sources already fetched (reuse these source_id handles with search_sources / read_source; cite the url in the report, never the source_id):\n" +
    lines.join("\n")
  );
}

function textFromBlocks(content: ModelAssistantBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function compactionUserPrompt(
  query: string | undefined,
  transcript: string,
): string {
  return [
    query ? `Research question: ${query}` : null,
    "Compress the following earlier research turns into a faithful progress note. Keep every concrete fact tied to the source_id that established it, the current best hypothesis, ruled-out paths, queries/URLs already tried, and the remaining gaps.",
    "Earlier turns:",
    transcript,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export async function maybeCompactResearchContext(opts: {
  ctx: ResearchCtx;
  messages: ModelMessage[];
}): Promise<boolean> {
  const { ctx, messages } = opts;
  const trigger = ctx.scope.compactionTriggerTokens ?? 0;
  if (!Number.isFinite(trigger) || trigger <= 0) return false;
  if (messages.length < 4) return false;

  const tokensBefore = estimateMessagesTokens(messages);
  if (tokensBefore <= trigger) return false;

  const keepTokens = Math.max(
    1,
    Math.floor(ctx.scope.compactionKeepTokens ?? Math.floor(trigger / 2)),
  );
  const cut = planCutIndex(messages, keepTokens);
  if (cut < 2) return false;

  const folded = messages.slice(1, cut);
  const foldedTokens = estimateMessagesTokens(folded);
  if (foldedTokens < MIN_FOLD_TOKENS) return false;

  const summarizer = ctx.deps.summaryModel ?? ctx.deps.model;
  let summary: string;
  try {
    const resp = await summarizer.step({
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: compactionUserPrompt(
            ctx.scope.query,
            renderFoldedForSummary(folded),
          ),
        },
      ],
      maxTokens: MAX_SUMMARY_TOKENS,
      signal: ctx.deps.signal,
    });
    summary = textFromBlocks(resp.content);
  } catch (err) {
    if (ctx.deps.signal?.aborted) throw err;
    return false;
  }
  if (!summary) return false;

  const sourceIndex = buildSourceIndex(ctx);
  const content = [
    "[Context compaction] Older research turns were summarized to free up context.",
    "Progress so far:",
    summary,
    sourceIndex,
    "Continue the research from the most recent turns below. Do not re-fetch sources already listed above; reuse their source_id handles.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const rewritten: ModelMessage[] = [
    messages[0],
    { role: "user", content },
    ...messages.slice(cut),
  ];
  const tokensAfter = estimateMessagesTokens(rewritten);
  messages.splice(0, messages.length, ...rewritten);

  ctx.scope.emit({
    type: "context_compacted",
    tokensBefore,
    tokensAfter,
    foldedMessages: cut - 1,
  });
  return true;
}

export const __testing = {
  planCutIndex,
  renderFoldedForSummary,
  buildSourceIndex,
  estimateMessageTokens,
};
