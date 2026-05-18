import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";
import { newJobId } from "../utils/id";

const CrawlRequest = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(500).default(100),
  maxDepth: z.number().int().min(0).optional(),
  maxDiscoveryDepth: z.number().int().min(0).optional(),
  includePaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  crawlEntireDomain: z.boolean().default(false),
  allowSubdomains: z.boolean().default(false),
  allowExternalLinks: z.boolean().default(false),
  ignoreRobotsTxt: z.boolean().default(false),
  sitemap: z.enum(["skip", "include", "only"]).default("include"),
  deduplicateSimilarURLs: z.boolean().default(true),
  ignoreQueryParameters: z.boolean().default(false),
  regexOnFullURL: z.boolean().default(false),
  delay: z.number().nonnegative().optional(),
  use_proxy: z.boolean().default(true),
});

export const crawlRoute = new Hono<AppEnv>();

crawlRoute.post("/", async (c) => {
  const requestId = c.get("request_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      envelopeFail(ErrorCodes.E_BAD_REQUEST, "Invalid JSON body", requestId),
      400,
    );
  }

  const parsed = CrawlRequest.safeParse(body);
  if (!parsed.success) {
    return c.json(
      envelopeFail(
        ErrorCodes.E_VALIDATION,
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        requestId,
      ),
      422,
    );
  }

  const id = newJobId();
  const ns = c.env.ATLAS_JOB;
  const stub = ns.get(ns.idFromName(id));

  try {
    const state = await stub.submitCrawl(id, parsed.data);
    return c.json(
      envelopeOk(
        {
          id: state.id,
          op: state.op,
          status: state.status,
          progress: state.progress,
          url: `/v1/crawl/${state.id}`,
          stream_url: `/v1/crawl/${state.id}/stream`,
        },
        requestId,
      ),
      202,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      envelopeFail(ErrorCodes.E_INTERNAL, `Failed to submit crawl: ${message}`, requestId),
      500,
    );
  }
});
