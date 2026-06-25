import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ResearchEvent } from "./events.js";

export interface SafetyPolicy {
  allowFlaggedUrls?: boolean;
  allowPrivateNetworks?: boolean;
}

export function quarantine(
  text: string,
  source: { sourceId?: string; url?: string },
): string {
  const tag = [source.sourceId, source.url].filter(Boolean).join(" ");
  return `<<<untrusted-source ${tag}>>>\n${text}\n<<<end-untrusted-source>>>`;
}

const MAX_URL_LENGTH = 2048;
const ENTROPY_MIN_QUERY_LENGTH = 64;
const ENTROPY_THRESHOLD = 4.6;

export type UrlGuardResult =
  | { ok: true }
  | { ok: false; reason: string; kind: "scheme" | "ssrf" | "url-entropy" };

function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isPrivateIPv4Octets(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  return isPrivateIPv4Octets(parts[0], parts[1]);
}

function parseIPv6Groups(ip: string): number[] | undefined {
  let text = ip;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const v4Tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4Tail) {
    const octets = v4Tail.slice(2, 6).map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${v4Tail[1]}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] =>
    half === "" ? [] : half.split(":").map((group) => Number.parseInt(group, 16));
  const head = parseHalf(halves[0]);
  const tail = halves.length === 2 ? parseHalf(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return undefined;
  if (halves.length === 2 && missing < 0) return undefined;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0),
    ...tail,
  ];
  if (groups.length !== 8) return undefined;
  if (groups.some((group) => Number.isNaN(group) || group < 0 || group > 0xffff)) {
    return undefined;
  }
  return groups;
}

function isPrivateIPv6(ip: string): boolean {
  const groups = parseIPv6Groups(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = (hi: number): boolean =>
    isPrivateIPv4Octets(hi >> 8, hi & 0xff);
  const leadingZeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZeros && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if (leadingZeros && g5 === 0xffff) return embeddedV4(g6);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embeddedV4(g6);
  }
  if (g0 === 0x2002) return embeddedV4(g1);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

export async function guardRedirect(
  rawUrl: string,
  policy: SafetyPolicy,
): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, kind: "scheme", reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      kind: "scheme",
      reason: `scheme ${url.protocol} is not allowed`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      kind: "ssrf",
      reason: "URLs with embedded credentials are not allowed",
    };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      kind: "ssrf",
      reason: `URL exceeds ${MAX_URL_LENGTH} characters`,
    };
  }

  if (!policy.allowPrivateNetworks) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname)) {
      if (isPrivateAddress(hostname)) {
        return {
          ok: false,
          kind: "ssrf",
          reason: `address ${hostname} is private or reserved`,
        };
      }
    } else {
      try {
        const records = await lookup(hostname, { all: true });
        for (const record of records) {
          if (isPrivateAddress(record.address)) {
            return {
              ok: false,
              kind: "ssrf",
              reason: `${hostname} resolves to private address ${record.address}`,
            };
          }
        }
      } catch {
        return {
          ok: false,
          kind: "ssrf",
          reason: `${hostname} did not resolve`,
        };
      }
    }
  }
  return { ok: true };
}

export async function guardUrl(
  rawUrl: string,
  opts: {
    policy: SafetyPolicy;
    seenDomains: Set<string>;
    emit?: (event: ResearchEvent) => void;
  },
): Promise<UrlGuardResult> {
  const target = await guardRedirect(rawUrl, opts.policy);
  if (!target.ok) return target;
  const url = new URL(rawUrl);

  const domain = url.hostname.toLowerCase();
  const newDomain = !opts.seenDomains.has(domain);
  if (newDomain) {
    const suspect = `${url.search}${url.hash}`.replace(/^[?#]/, "");
    if (
      suspect.length >= ENTROPY_MIN_QUERY_LENGTH &&
      shannonEntropy(suspect) >= ENTROPY_THRESHOLD &&
      !opts.policy.allowFlaggedUrls
    ) {
      opts.emit?.({
        type: "safety.flag",
        kind: "url-entropy",
        detail: `high-entropy query string on first-seen domain ${domain}`,
        url: rawUrl,
      });
      return {
        ok: false,
        kind: "url-entropy",
        reason:
          "high-entropy query string on a never-seen domain (possible data exfiltration); set safety.allowFlaggedUrls to permit",
      };
    }
  }
  opts.seenDomains.add(domain);
  return { ok: true };
}
