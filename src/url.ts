const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
]);

export function normalizeUrlForSource(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lower)) {
        u.searchParams.delete(key);
      }
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
}
