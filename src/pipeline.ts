export const RESEARCH_MODEL = "claude-sonnet-4-6";

export type ResearchEffort = "low" | "medium" | "high" | "max";

export interface CitedSource {
  url: string;
  title: string;
}
