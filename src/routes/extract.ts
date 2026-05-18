import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { hasAnthropicKey } from "../llm";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";
import { newJobId } from "../utils/id";

const ExtractRequest = z.object({
  urls: z.array(z.string().url()).min(1).max(5),
  schema: z.record(z.string(), z.unknown()),
  prompt: z.string().max(2048).optional(),
  use_proxy: z.boolean().optional(),
});

export const extractRoute = new Hono<AppEnv>();

extractRoute.post("/", async (c) => {
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

  const parsed = ExtractRequest.safeParse(body);
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

  if (!hasAnthropicKey(c.env)) {
    console.error("ANTHROPIC_API_KEY secret is not set");
    return c.json(
      envelopeFail(
        ErrorCodes.E_INTERNAL,
        "Server is misconfigured (ANTHROPIC_API_KEY missing)",
        requestId,
      ),
      500,
    );
  }

  const id = newJobId();
  const ns = c.env.ATLAS_JOB;
  const stub = ns.get(ns.idFromName(id));

  try {
    const state = await stub.submitExtract(id, parsed.data);
    return c.json(
      envelopeOk(
        {
          id: state.id,
          op: state.op,
          status: state.status,
          progress: state.progress,
          url: `/v1/extract/${state.id}`,
          stream_url: `/v1/extract/${state.id}/stream`,
        },
        requestId,
      ),
      202,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      envelopeFail(ErrorCodes.E_INTERNAL, `Failed to submit job: ${message}`, requestId),
      500,
    );
  }
});
