export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-7";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const RESEARCH_MODEL = DEFAULT_ANTHROPIC_MODEL;

export type ResearchEffort = "low" | "medium" | "high" | "max";

export interface CitedSource {
  url: string;
  title: string;
}
