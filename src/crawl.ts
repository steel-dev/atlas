import * as cheerio from "cheerio";

// ============================================================
// URL normalization + permutations
// ============================================================

export function normalizeUrl(
  input: string,
  opts: { ignoreQueryParameters?: boolean } = {},
): string | null {
  try {
    const u = new URL(input);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hash && !u.hash.startsWith("#/")) u.hash = "";
    if (opts.ignoreQueryParameters) u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

const INDEX_FILES = ["/index.html", "/index.php", "/index.htm"];

export function canonicalKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.replace(/^www\./i, "");
  let path = u.pathname;
  const lower = path.toLowerCase();
  for (const f of INDEX_FILES) {
    if (lower.endsWith(f)) {
      path = path.slice(0, -f.length) + "/";
      break;
    }
  }
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `https://${host}${path}${u.search}${u.hash}`;
}

// ============================================================
// robots.txt
// ============================================================

export interface RobotsRules {
  disallows: string[];
  sitemaps: string[];
}

export async function fetchRobotsTxt(baseUrl: string): Promise<RobotsRules | null> {
  try {
    const u = new URL(baseUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const res = await fetch(robotsUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return parseRobotsTxt(await res.text());
  } catch {
    return null;
  }
}

export function parseRobotsTxt(text: string): RobotsRules {
  const disallows: string[] = [];
  const sitemaps: string[] = [];
  let inMatchingGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      inMatchingGroup = value === "*";
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (inMatchingGroup && field === "disallow" && value) {
      disallows.push(value);
    }
  }

  return { disallows, sitemaps };
}

export function isDisallowedByRobots(url: string, rules: RobotsRules | null): boolean {
  if (!rules) return false;
  try {
    const path = new URL(url).pathname;
    for (const dis of rules.disallows) {
      if (dis === "/") return true;
      if (path.startsWith(dis)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================
// Sitemap
// ============================================================

const SITEMAP_INNER_CAP = 5_000;
const SITEMAP_FANOUT_CAP = 5;

export async function fetchSitemap(sitemapUrl: string, maxDepth = 2): Promise<string[]> {
  if (maxDepth <= 0) return [];
  try {
    const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    const subSitemaps: string[] = [];
    $("sitemap > loc").each((_i, el) => {
      const u = $(el).text().trim();
      if (u) subSitemaps.push(u);
    });

    if (subSitemaps.length > 0) {
      const all: string[] = [];
      for (const sub of subSitemaps.slice(0, SITEMAP_FANOUT_CAP)) {
        const urls = await fetchSitemap(sub, maxDepth - 1);
        all.push(...urls);
        if (all.length > SITEMAP_INNER_CAP) break;
      }
      return all.slice(0, SITEMAP_INNER_CAP);
    }

    const urls: string[] = [];
    $("url > loc").each((_i, el) => {
      const u = $(el).text().trim();
      if (u && /^https?:\/\//i.test(u)) urls.push(u);
    });
    return urls.slice(0, SITEMAP_INNER_CAP);
  } catch {
    return [];
  }
}

export function discoverSitemapCandidates(
  baseUrl: string,
  robotsRules: RobotsRules | null,
): string[] {
  const candidates = new Set<string>();
  for (const s of robotsRules?.sitemaps ?? []) candidates.add(s);
  try {
    const u = new URL(baseUrl);
    candidates.add(`${u.protocol}//${u.host}/sitemap.xml`);
    if (u.pathname !== "/" && u.pathname !== "") {
      candidates.add(new URL("sitemap.xml", baseUrl).toString());
    }
  } catch {
    // ignore
  }
  return [...candidates].slice(0, 20);
}

// ============================================================
// 9-step filter chain (port of Firecrawl crawler.ts:285-449)
// ============================================================

const DENY_PROTOCOL_PREFIXES = [
  "mailto:",
  "tel:",
  "ftp:",
  "javascript:",
  "data:",
  "blob:",
  "ws:",
  "wss:",
];

const DENY_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
  ".css", ".js", ".mjs", ".cjs", ".map",
  ".zip", ".tar", ".gz", ".rar", ".7z", ".bz2",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".mkv", ".wav", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dmg", ".msi", ".pkg", ".deb", ".rpm",
];

export interface CrawlFilterOptions {
  initialUrl: string;
  maxDepth?: number;
  excludePaths?: string[];
  includePaths?: string[];
  crawlEntireDomain?: boolean;
  allowSubdomains?: boolean;
  allowExternalLinks?: boolean;
  regexOnFullURL?: boolean;
  ignoreQueryParameters?: boolean;
  robotsRules?: RobotsRules | null;
}

export function passesFilter(url: string, opts: CrawlFilterOptions): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }

  const lowerUrl = url.toLowerCase();
  if (DENY_PROTOCOL_PREFIXES.some((p) => lowerUrl.startsWith(p))) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  let initial: URL;
  try {
    initial = new URL(opts.initialUrl);
  } catch {
    return false;
  }

  if (opts.maxDepth !== undefined && opts.maxDepth >= 0) {
    const segs = u.pathname.split("/").filter(Boolean).length;
    if (segs > opts.maxDepth) return false;
  }

  if (!opts.allowExternalLinks) {
    if (opts.allowSubdomains) {
      if (!shareRegistrable(u.hostname, initial.hostname)) return false;
    } else {
      const a = u.hostname.replace(/^www\./, "");
      const b = initial.hostname.replace(/^www\./, "");
      if (a !== b) return false;
    }
  }

  if (!opts.crawlEntireDomain && u.hostname === initial.hostname) {
    if (!u.pathname.startsWith(initial.pathname)) return false;
  }

  const target = opts.regexOnFullURL ? url : u.pathname;

  for (const pat of opts.excludePaths ?? []) {
    if (matchRegex(pat, target)) return false;
  }

  const inc = opts.includePaths ?? [];
  if (inc.length > 0) {
    let any = false;
    for (const pat of inc) {
      if (matchRegex(pat, target)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }

  if (isDisallowedByRobots(url, opts.robotsRules ?? null)) return false;

  const lowerPath = u.pathname.toLowerCase();
  for (const ext of DENY_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) return false;
  }

  return true;
}

export function filterCandidates(urls: string[], opts: CrawlFilterOptions): string[] {
  const normOpts = { ignoreQueryParameters: opts.ignoreQueryParameters };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const n = normalizeUrl(raw, normOpts);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    if (passesFilter(n, opts)) out.push(n);
  }
  return out;
}

function shareRegistrable(a: string, b: string): boolean {
  const aParts = a.split(".");
  const bParts = b.split(".");
  if (aParts.length < 2 || bParts.length < 2) return a === b;
  return aParts.slice(-2).join(".") === bParts.slice(-2).join(".");
}

function matchRegex(pattern: string, target: string): boolean {
  try {
    return new RegExp(pattern).test(target);
  } catch {
    return false;
  }
}
