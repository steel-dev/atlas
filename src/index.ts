import { Hono } from "hono";
import { logger } from "hono/logger";
import type { Env } from "./env";
import { envelopeFail, envelopeOk } from "./utils/envelope";
import { ErrorCodes } from "./utils/errors";
import { newJobId, newRequestId } from "./utils/id";

export { AtlasJob } from "./do/atlas-job";

type Variables = { request_id: string };
type AppEnv = { Bindings: Env; Variables: Variables };

const ASYNC_OPS = ["extract", "crawl", "research", "task"] as const;
type AsyncOp = (typeof ASYNC_OPS)[number];

const app = new Hono<AppEnv>();

app.use("*", logger());

app.use("*", async (c, next) => {
  c.set("request_id", newRequestId());
  await next();
});

app.get("/", (c) =>
  c.json(
    envelopeOk(
      {
        name: "atlas",
        version: "0.0.1",
        docs: "https://github.com/steel-experiments/atlas",
      },
      c.get("request_id"),
    ),
  ),
);

const v1 = new Hono<AppEnv>();

const notImplemented = (op: string) => (c: any) =>
  c.json(
    envelopeFail(
      ErrorCodes.E_NOT_IMPLEMENTED,
      `${op} is not implemented yet`,
      c.get("request_id"),
    ),
    501,
  );

v1.post("/search", notImplemented("/v1/search"));
v1.post("/fetch", notImplemented("/v1/fetch"));

const submitAsync = (op: AsyncOp) => (c: any) => {
  const id = newJobId();
  return c.json(
    envelopeOk(
      {
        id,
        op,
        status: "queued",
        url: `/v1/${op}/${id}`,
        stream_url: `/v1/${op}/${id}/stream`,
      },
      c.get("request_id"),
    ),
    202,
  );
};

v1.post("/extract", submitAsync("extract"));
v1.post("/crawl", submitAsync("crawl"));
v1.post("/research", submitAsync("research"));
v1.post("/task", submitAsync("task"));

const forwardToJob = async (c: any) => {
  const id = c.req.param("id") as string;
  const ns = c.env.ATLAS_JOB as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(id));
  return stub.fetch(c.req.raw);
};

const ASYNC_OP_PATTERN = `:op{${ASYNC_OPS.join("|")}}`;

v1.get(`/${ASYNC_OP_PATTERN}/:id`, forwardToJob);
v1.get(`/${ASYNC_OP_PATTERN}/:id/stream`, forwardToJob);
v1.delete(`/${ASYNC_OP_PATTERN}/:id`, forwardToJob);

app.route("/v1", v1);

app.notFound((c) =>
  c.json(
    envelopeFail(
      ErrorCodes.E_NOT_FOUND,
      "Route not found",
      c.get("request_id"),
    ),
    404,
  ),
);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    envelopeFail(
      ErrorCodes.E_INTERNAL,
      err.message ?? "Internal error",
      c.get("request_id"),
    ),
    500,
  );
});

export default app;
