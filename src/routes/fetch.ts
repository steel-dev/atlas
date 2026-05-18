import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";
import { getSteel, looksBlocked } from "../steel";

const FORMATS = ["markdown", "html", "cleaned_html", "readability"] as const;

const FetchRequest = z.object({
  url: z.string().url(),
  format: z.enum(FORMATS).default("markdown"),
  use_proxy: z.boolean().default(false),
  delay: z.number().int().min(0).max(30_000).optional(),
});

export const fetchRoute = new Hono<AppEnv>();

fetchRoute.post("/", async (c) => {
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

  const parsed = FetchRequest.safeParse(body);
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

  const { url, format, use_proxy, delay } = parsed.data;
  const steel = getSteel(c.env);

  try {
    const result = await steel.scrape({
      url,
      format: [format],
      useProxy: use_proxy,
      delay,
    });

    const content = result.content?.[format];
    const blocked = format === "html" || format === "cleaned_html"
      ? looksBlocked(typeof content === "string" ? content : null)
      : false;

    if (blocked) {
      return c.json(
        envelopeFail(
          ErrorCodes.E_STEEL_UNAVAILABLE,
          "Target page returned an anti-bot challenge",
          requestId,
        ),
        502,
      );
    }

    return c.json(
      envelopeOk(
        {
          url,
          format,
          status_code: result.metadata?.statusCode ?? null,
          title: result.metadata?.title ?? null,
          description: result.metadata?.description ?? null,
          content: content ?? null,
          links_count: result.links?.length ?? 0,
          metadata: result.metadata ?? {},
        },
        requestId,
      ),
    );
  } catch (err) {
    return mapSteelError(c, err, requestId);
  }
});

function mapSteelError(c: any, err: unknown, requestId: string) {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;

  if (status === 408 || /timeout/i.test(message)) {
    return c.json(
      envelopeFail(ErrorCodes.E_STEEL_TIMEOUT, message, requestId),
      504,
    );
  }
  return c.json(
    envelopeFail(ErrorCodes.E_STEEL_UNAVAILABLE, message, requestId),
    502,
  );
}
