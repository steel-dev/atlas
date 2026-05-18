import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ENGINES, webSearch } from "../search";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";

const SearchRequest = z.object({
  query: z.string().min(1).max(2048),
  limit: z.number().int().min(1).max(50).default(10),
  engine: z.enum(ENGINES).default("ddg"),
  country: z.string().length(2).optional(),
  lang: z.string().min(2).max(5).optional(),
  use_proxy: z.boolean().default(true),
});

export const searchRoute = new Hono<AppEnv>();

searchRoute.post("/", async (c) => {
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

  const parsed = SearchRequest.safeParse(body);
  if (!parsed.success) {
    return c.json(
      envelopeFail(
        ErrorCodes.E_VALIDATION,
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        requestId,
      ),
      422,
    );
  }

  const outcome = await webSearch({
    env: c.env,
    ...parsed.data,
  });
  if (!outcome.ok) {
    const status = outcome.error.code === "E_STEEL_TIMEOUT" ? 504 : 502;
    return c.json(
      envelopeFail(
        outcome.error.code === "E_STEEL_TIMEOUT"
          ? ErrorCodes.E_STEEL_TIMEOUT
          : ErrorCodes.E_STEEL_UNAVAILABLE,
        outcome.error.message,
        requestId,
      ),
      status,
    );
  }

  return c.json(
    envelopeOk(
      {
        query: parsed.data.query,
        engine: parsed.data.engine,
        results_count: outcome.results.length,
        results: outcome.results,
      },
      requestId,
    ),
  );
});
