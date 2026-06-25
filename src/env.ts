export function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

// Provider SDKs inherit these base-url env vars and route model calls through
// them. When one points at a mismatched proxy (e.g. a non-Anthropic API behind
// ANTHROPIC_BASE_URL), every model call fails with no other signal — so callers
// (examples/serve.ts) warn at startup when any is set.
const PROXY_BASE_URL_VARS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "ZAI_BASE_URL",
  "ATLAS_ZAI_BASE_URL",
] as const;

export function detectProxyBaseURL(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return PROXY_BASE_URL_VARS.filter((name) => !!env[name]);
}
