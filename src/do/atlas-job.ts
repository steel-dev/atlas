import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { envelopeFail } from "../utils/envelope";
import { ErrorCodes } from "../utils/errors";

export class AtlasJob extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return Response.json(
      envelopeFail(
        ErrorCodes.E_NOT_IMPLEMENTED,
        "AtlasJob DO is stubbed; real lifecycle (runFiber + SQLite + SSE) lands in the next step.",
        crypto.randomUUID(),
      ),
      { status: 501 },
    );
  }
}
