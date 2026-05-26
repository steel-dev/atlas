export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const RESEARCH_MODEL = "claude-sonnet-4-6";

export type ResearchEffort = "low" | "medium" | "high" | "max";

export interface CitedSource {
  url: string;
  title: string;
}
