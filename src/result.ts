// ABOUTME: Shared result-shape types that are consumed by core runs and CLI outcome logic.
// ABOUTME: Keeps degraded completed-run metadata structured instead of inferred from report text.

export type ResearchFailurePhase = "gather" | "synthesis";

export interface ResearchFailure {
  phase: ResearchFailurePhase;
  message: string;
}
