const RENDER_MAX_SEARCHES = 50;
const RENDER_MAX_DEAD_ENDS = 25;
const REASON_MAX_CHARS = 120;

export interface TrailRenderOptions {
  maxSearches?: number;
  maxDeadEnds?: number;
}

export interface Trail {
  readonly searchCount: number;
  readonly deadEndCount: number;
  recordSearch(query: string, results: number): void;
  recordDeadEnd(url: string, reason: string): void;
  render(opts?: TrailRenderOptions): string;
}

export function createTrail(): Trail {
  const searches = new Map<string, { query: string; results: number }>();
  const deadEnds = new Map<string, string>();

  return {
    get searchCount() {
      return searches.size;
    },
    get deadEndCount() {
      return deadEnds.size;
    },
    recordSearch(query, results) {
      const text = query.trim();
      if (!text) return;
      const key = text.toLowerCase();
      const existing = searches.get(key);
      if (existing) {
        existing.results = Math.max(existing.results, results);
      } else {
        searches.set(key, { query: text, results });
      }
    },
    recordDeadEnd(url, reason) {
      const target = url.trim();
      if (!target || deadEnds.has(target)) return;
      deadEnds.set(target, reason.trim().slice(0, REASON_MAX_CHARS));
    },
    render(opts = {}) {
      const maxSearches = opts.maxSearches ?? RENDER_MAX_SEARCHES;
      const maxDeadEnds = opts.maxDeadEnds ?? RENDER_MAX_DEAD_ENDS;
      const lines: string[] = [];
      if (searches.size > 0) {
        lines.push(
          `Searches already run (${searches.size} — do not repeat them; vary the terms or angle instead):`,
        );
        const entries = [...searches.values()];
        for (const entry of entries.slice(0, maxSearches)) {
          lines.push(`- "${entry.query}" → ${entry.results} result(s)`);
        }
        if (entries.length > maxSearches) {
          lines.push(`…and ${entries.length - maxSearches} more searches`);
        }
      }
      if (deadEnds.size > 0) {
        lines.push("Dead-end fetches (no usable content came back):");
        const entries = [...deadEnds.entries()];
        for (const [url, reason] of entries.slice(0, maxDeadEnds)) {
          lines.push(`- ${url} — ${reason}`);
        }
        if (entries.length > maxDeadEnds) {
          lines.push(`…and ${entries.length - maxDeadEnds} more dead ends`);
        }
      }
      return lines.join("\n");
    },
  };
}
