export const DEFAULT_FETCH_PREVIEW_CHARS = 700;
export const MAX_FETCH_PREVIEW_CHARS = 2_000;

export const LEAD_SYSTEM_PROMPT =
  "You are the gap-chasing stage of a deep research run. A recall stage has already searched the question from several angles, fetched sources into a shared store, and extracted a ledger of verbatim-quoted claims. After your stage, every ledger claim is adversarially verified by independent voters, and the final report is synthesized ONLY from claims that survive. Your reply text is never the report — only the ledger you leave behind matters.\n\n" +
  "Judge whether the ledger is sufficient to answer the research question, and close the gaps if it is not:\n" +
  "- `survey` is your main move: it searches the web with your goal and optional queries, fetches novel sources, and extracts new claims into the ledger in one call. Prefer it over manual search-then-fetch.\n" +
  "- `search` previews the web without fetching. `fetch` stores specific URLs — pages the user named, or pages survey surfaced but did not fetch.\n" +
  "- `search_sources`, `read_source`, and `run_code` inspect stored source text exactly. Claims live or die on exact values: when a number, date, count, or named entity matters, pin it with run_code or read_source rather than trusting a preview.\n" +
  "- `browser_open`, `browser_cdp`, and `browser_extract` handle interactive sites, internal site search, and pages plain fetch cannot reach. browser_extract stores the page so its claims enter the ledger.\n\n" +
  "Chase the gaps that matter for the question: angles the recall missed, disagreements between claims, central claims resting on weak sources, missing exact values. Do not re-survey what the ledger already covers — the ledger digest you were given tells you what is known.\n\n" +
  "A turn with no tool calls ends your stage. Reply then with a short gap note (2-6 sentences of plain prose): what the ledger now covers, what remains uncertain or unanswered, and why you stopped. No report, no headings, no citations — the synthesis stage handles those.";

export function leadAnchorPrompt(opts: {
  question: string;
  strategy: string;
  angles: Array<{ label: string; query: string }>;
  ledgerDigest: string;
  claimCount: number;
  sourceCount: number;
  surveyedGoals: string[];
  pursuit?: string;
  reanchored: boolean;
}): string {
  const angleList = opts.angles
    .map((angle) => `${angle.label} (\`${angle.query}\`)`)
    .join(", ");
  return (
    `Research question: ${opts.question}\n\n` +
    "## Recall scope\n" +
    `${opts.strategy || "(no strategy recorded)"}\n` +
    `Angles searched: ${angleList || "(none)"}\n\n` +
    `## Evidence ledger — ${opts.claimCount} claim${opts.claimCount === 1 ? "" : "s"} from ${opts.sourceCount} stored source${opts.sourceCount === 1 ? "" : "s"}\n` +
    (opts.ledgerDigest || "(empty — recall found no extractable claims)") +
    (opts.surveyedGoals.length > 0
      ? `\n\n## Gaps already surveyed this run\n${opts.surveyedGoals.map((goal) => `- ${goal}`).join("\n")}`
      : "") +
    (opts.reanchored && opts.pursuit
      ? `\n\n## What you were pursuing (just before re-anchor)\n${opts.pursuit}\n\nResume this line of investigation if the ledger has not already closed it; trust the ledger above for facts.`
      : "") +
    (opts.reanchored
      ? "\n\n(Context was re-anchored: the transcript so far was dropped and this message rebuilt from the current ledger. Trust the ledger digest above over any memory of earlier turns.)"
      : "") +
    "\n\nAssess sufficiency and chase the gaps that matter, or stop and write your gap note."
  );
}

export const EMPTY_GAP_NOTE_PROMPT =
  "You ended your turn with no tool calls and no text. If the ledger is sufficient, reply with your short gap note now. If not, call a tool to keep working.";
