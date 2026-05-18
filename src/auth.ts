import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env";
import { envelopeFail } from "./utils/envelope";
import { ErrorCodes } from "./utils/errors";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.get("request_id");

  const expected = c.env.ATLAS_API_KEY;
  if (!expected) {
    console.error("ATLAS_API_KEY secret is not set");
    return c.json(
      envelopeFail(
        ErrorCodes.E_INTERNAL,
        "Server auth is misconfigured (ATLAS_API_KEY missing)",
        requestId,
      ),
      500,
    );
  }
  if (!c.env.STEEL_API_KEY) {
    console.error("STEEL_API_KEY secret is not set");
    return c.json(
      envelopeFail(
        ErrorCodes.E_INTERNAL,
        "Server is misconfigured (STEEL_API_KEY missing)",
        requestId,
      ),
      500,
    );
  }

  const bearer = parseBearer(c.req.header("Authorization"));
  if (!bearer) {
    return c.json(
      envelopeFail(
        ErrorCodes.E_UNAUTHORIZED,
        "Missing or malformed Authorization header (expected: Bearer <token>)",
        requestId,
      ),
      401,
    );
  }

  if (!(await timingSafeEqual(bearer, expected))) {
    return c.json(
      envelopeFail(ErrorCodes.E_UNAUTHORIZED, "Invalid API key", requestId),
      401,
    );
  }

  return await next();
});

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// SHA-256 both sides into fixed 32-byte buffers, then XOR-compare. Avoids the
// length-leak of an early-return on length mismatch and the per-char timing of
// a JS string compare loop.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const av = new Uint8Array(ah);
  const bv = new Uint8Array(bh);
  let mismatch = 0;
  for (let i = 0; i < av.length; i++) mismatch |= av[i] ^ bv[i];
  return mismatch === 0;
}
