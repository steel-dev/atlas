export const USER_AGENT =
  "atlas-research/0.1 (+https://github.com/steel-experiments/atlas)";

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clampLimit(n: number, max = 25): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

export async function fetchText(
  url: string,
  signal: AbortSignal | undefined,
  accept: string,
): Promise<string> {
  const resp = await fetch(url, {
    signal,
    headers: { "user-agent": USER_AGENT, accept },
  });
  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());
  return resp.text();
}

export async function fetchJson(
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return JSON.parse(await fetchText(url, signal, "application/json"));
}

export function buildContent(parts: {
  title: string;
  authors?: string[];
  meta?: string[];
  abstract?: string;
}): string {
  const lines: string[] = [parts.title];
  if (parts.authors?.length) lines.push(`Authors: ${parts.authors.join(", ")}`);
  for (const m of parts.meta ?? []) if (m) lines.push(m);
  const body = parts.abstract?.trim();
  if (body) lines.push("", body);
  return lines.join("\n");
}

export function manifest(
  tool: string,
  query: string,
  titles: string[],
): string {
  if (titles.length === 0) return `${tool}: no results for "${query}"`;
  const list = titles.map((t) => `- ${t}`).join("\n");
  return `${tool}: found ${titles.length} result(s) for "${query}"; submitted as sources:\n${list}`;
}
