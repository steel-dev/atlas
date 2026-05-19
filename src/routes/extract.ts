import { Hono } from "hono";
import type { AppEnv } from "../env";
import { hasAnthropicKey } from "../llm";
import { ExtractRequest } from "../schemas";
import { envelopeFail, envelopeOk } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";
import { newJobId } from "../utils/id";
import {
  deriveJobIdFromKey,
  parseIdempotencyHeader,
  sha256Hex,
} from "../utils/idempotency";

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
    const result = await stub.submitExtract(id, parsed.data, bodyHash);
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
          url: `/v1/extract/${state.id}`,
          stream_url: `/v1/extract/${state.id}/stream`,
        },
        requestId,
      ),
      result.kind === "submitted" ? 202 : 200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      envelopeFail(ErrorCodes.E_INTERNAL, `Failed to submit job: ${message}`, requestId),
      500,
    );
  }
});
