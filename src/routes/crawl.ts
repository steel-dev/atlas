import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";
import { newJobId } from "../utils/id";
import {
  deriveJobIdFromKey,
  parseIdempotencyHeader,
  sha256Hex,
} from "../utils/idempotency";

const CrawlRequest = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(10_000).default(100),
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
  use_proxy: z.boolean().default(false),
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

  const idem = parseIdempotencyHeader(c.req.header("Idempotency-Key"));
  if (!idem.ok) {
    return c.json(
      envelopeFail(ErrorCodes.E_VALIDATION, idem.error, requestId),
      422,
    );
  }

  const bodyHash = idem.key
    ? await sha256Hex(JSON.stringify(parsed.data))
    : null;
  const id = idem.key ? await deriveJobIdFromKey(idem.key) : newJobId();
  const ns = c.env.ATLAS_JOB;
  const stub = ns.get(ns.idFromName(id));

  try {
    const result = await stub.submitCrawl(id, parsed.data, bodyHash);
    if (result.kind === "conflict") {
      return c.json(
        envelopeFail(ErrorCodes.E_IDEMPOTENCY_CONFLICT, result.error, requestId),
        409,
      );
    }
    const { state } = result;
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
      result.kind === "submitted" ? 202 : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      envelopeFail(ErrorCodes.E_INTERNAL, `Failed to submit crawl: ${message}`, requestId),
      500,
    );
  }
});
