export interface ResearcherContext {
  budget: { maxUSD: number };
  readonly signal?: AbortSignal | undefined;
  log(message: string): void;
}

export interface ResearchReport {
  report: string;
  sources: { url: string; title?: string }[];
  cost?: number;
}

export interface Researcher {
  description: string;
  research(query: string, ctx: ResearcherContext): Promise<ResearchReport>;
}

export function researcher(r: Researcher): Researcher {
  return r;
}
