export function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

// Provider SDKs inherit these base-url env vars and route model calls through
// them. App-owned Z.ai base-url settings are intentionally excluded: Atlas
// passes those explicitly and they are valid documented configuration.
const INHERITED_BASE_URL_BY_PROVIDER = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
} as const;

export type InheritedBaseURLProvider = keyof typeof INHERITED_BASE_URL_BY_PROVIDER;

export function detectProxyBaseURL(
  env: Record<string, string | undefined> = process.env,
  options: { providers?: readonly InheritedBaseURLProvider[] } = {},
): string[] {
  const providers =
    options.providers ??
    (Object.keys(
      INHERITED_BASE_URL_BY_PROVIDER,
    ) as InheritedBaseURLProvider[]);
  return providers
    .map((provider) => INHERITED_BASE_URL_BY_PROVIDER[provider])
    .filter((name, index, names) => names.indexOf(name) === index)
    .filter((name) => !!env[name]);
}

export function proxyBaseURLWarning(name: string): string {
  return (
    `${name} is set; the matching provider SDK routes model calls through this base URL. ` +
    "If it points at a mismatched proxy, model calls can fail before Atlas sees a usable response."
  );
}
