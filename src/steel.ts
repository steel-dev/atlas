import Steel from "steel-sdk";
import type { Env } from "./env";

export function getSteel(env: Env): Steel {
  const key = env.STEEL_API_KEY;
  if (!key) {
    throw new Error("STEEL_API_KEY secret is not set");
  }
  return new Steel({
    steelAPIKey: key,
    baseURL: env.STEEL_BASE_URL,
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
