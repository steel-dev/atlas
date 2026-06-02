import Steel from "steel-sdk";

export interface SteelOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createSteel(opts: SteelOptions): Steel {
  if (!opts.apiKey) {
    throw new Error("Steel API key is required");
  }
  return new Steel({
    steelAPIKey: opts.apiKey,
    baseURL: opts.baseUrl,
    maxRetries: 0,
  });
}

export interface BrowserProvider {
  readonly kind: "steel";
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly proxy?: boolean;
}

export interface SteelBrowserOptions {
  apiKey?: string;
  baseUrl?: string;
  proxy?: boolean;
}

export function steel(opts: SteelBrowserOptions = {}): BrowserProvider {
  return {
    kind: "steel",
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
  };
}

const ANTI_BOT_MARKERS = [
  "just a moment",
  "verifying you are human",
  "checking your browser",
  "enable javascript and cookies",
  "access denied",
  "captcha",
  "pardon our interruption",
  "unusual traffic from your computer network",
];

export function looksBlocked(html: string | undefined | null): boolean {
  if (!html) return false;
  const lower = html.toLowerCase().slice(0, 4000);
  return ANTI_BOT_MARKERS.some((m) => lower.includes(m));
}
