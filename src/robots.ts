const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_CHARS = 512_000;

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export function parseRobots(text: string, agentToken: string): RobotsRule[] {
  const token = agentToken.toLowerCase();
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let agentsOpen = false;
  for (const rawLine of text.slice(0, ROBOTS_MAX_CHARS).split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!agentsOpen || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
        agentsOpen = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue;
      agentsOpen = false;
      if (value) {
        current.rules.push({ allow: field === "allow", pattern: value });
      }
    } else {
      agentsOpen = false;
    }
  }

  let best: RobotsRule[] | null = null;
  let bestAgentLength = -1;
  let wildcard: RobotsRule[] | null = null;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === "*") {
        wildcard = [...(wildcard ?? []), ...group.rules];
      } else if (token.includes(agent) && agent.length > bestAgentLength) {
        best = group.rules;
        bestAgentLength = agent.length;
      }
    }
  }
  return best ?? wildcard ?? [];
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    "^" +
      body
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      (anchored ? "$" : ""),
  );
  return regex.test(path);
}

export function robotsAllows(rules: RobotsRule[], path: string): boolean {
  let verdict = true;
  let matchedLength = -1;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      rule.pattern.length > matchedLength ||
      (rule.pattern.length === matchedLength && rule.allow && !verdict)
    ) {
      matchedLength = rule.pattern.length;
      verdict = rule.allow;
    }
  }
  return verdict;
}

export interface RobotsCache {
  allows(url: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RobotsCacheOptions {
  agentToken: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export function createRobotsCache(opts: RobotsCacheOptions): RobotsCache {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const byOrigin = new Map<string, Promise<RobotsRule[] | null>>();

  function load(origin: string, signal?: AbortSignal): Promise<RobotsRule[] | null> {
    let pending = byOrigin.get(origin);
    if (!pending) {
      pending = (async () => {
        try {
          const timeout = AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS);
          const response = await fetchImpl(`${origin}/robots.txt`, {
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: { "user-agent": opts.userAgent },
          });
          if (!response.ok) return null;
          const text = await response.text();
          return parseRobots(text, opts.agentToken);
        } catch {
          return null;
        }
      })();
      byOrigin.set(origin, pending);
    }
    return pending;
  }

  return {
    async allows(url, signal) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return true;
      }
      const rules = await load(parsed.origin, signal);
      if (!rules || rules.length === 0) return true;
      return robotsAllows(rules, parsed.pathname + parsed.search);
    },
  };
}
