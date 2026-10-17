import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type SearchProvider,
  type SearchResult,
  safeDomain,
} from "./search.js";

export interface ParallelSearchOptions {
  /** Omit for anonymous search. Environment API keys are not read. */
  apiKey?: string;
  /** Total time allowed for connection and search, in milliseconds. */
  timeoutMs?: number;
}

const ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT = "atlas (https://github.com/steel-dev/atlas)";
const SearchResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      excerpts: z.array(z.string()),
    }),
  ),
});

/** Opt-in Parallel Search MCP provider. Anonymous requests use Fast mode. */
export function parallelSearch(
  opts: ParallelSearchOptions = {},
): SearchProvider {
  const sessionId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    id: "parallel",
    async search({ query, maxResults, signal }) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // Keep MCP loading and connection setup out of existing provider paths.
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all(
        [
          import("@modelcontextprotocol/sdk/client/index.js"),
          import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        ],
      );
      callSignal.throwIfAborted();
      const client = new Client({
        name: "atlas-parallel-search",
        version: "1.0.0",
      });
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: {
          headers: {
            "User-Agent": USER_AGENT,
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
        },
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([callSignal, init.signal])
              : callSignal,
          }),
      });
      try {
        await client.connect(transport, {
          signal: callSignal,
          timeout: timeoutMs,
        });
        const response = await client.callTool(
          {
            name: "web_search",
            arguments: {
              objective: query,
              search_queries: [query],
              session_id: sessionId,
            },
          },
          undefined,
          { signal: callSignal, timeout: timeoutMs },
        );
        const text = z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .parse(response.content)
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (response.isError) {
          throw new Error(`parallel.search: ${text.slice(0, 500)}`);
        }
        const data = SearchResponse.parse(
          response.structuredContent ?? JSON.parse(text),
        );
        const limit = Math.min(20, Math.max(1, Math.floor(maxResults ?? 8)));
        const results: SearchResult[] = [];
        for (const row of data.results) {
          if (!/^https?:\/\//i.test(row.url)) continue;
          results.push({
            position: results.length + 1,
            title: row.title?.trim() || row.url,
            url: row.url,
            snippet: row.excerpts.join(" … ").trim().slice(0, 500),
            domain: safeDomain(row.url),
          });
          if (results.length >= limit) break;
        }
        return results;
      } finally {
        await client.close();
      }
    },
  };
}
