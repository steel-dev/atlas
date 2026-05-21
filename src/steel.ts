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
    // Internal retries make AbortSignal less effective (a retry can resume
    // after the user cancelled) and amplify worst-case wall-clock. Atlas
    // surfaces failures to the gather agent, which can pivot to a different URL.
    maxRetries: 0,
  });
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
