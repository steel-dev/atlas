const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const BARE_YEAR = /^(?:19|20)\d{2}$/;

function tokenize(query: string): string[] {
  return query.toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
}

export function canonicalQuery(query: string): string {
  return [...new Set(tokenize(query))].sort().join(" ");
}

export function trailKey(query: string): string {
  const tokens = tokenize(query).filter((token) => !BARE_YEAR.test(token));
  const canonical = [...new Set(tokens)].sort().join(" ");
  return canonical || query.trim().toLowerCase();
}
