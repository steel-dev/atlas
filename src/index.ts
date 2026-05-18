import { Hono } from "hono";
import { logger } from "hono/logger";
import { authMiddleware } from "./auth";
import type { AppEnv } from "./env";
import { crawlRoute } from "./routes/crawl";
import { extractRoute } from "./routes/extract";
import { fetchRoute } from "./routes/fetch";
import { researchRoute } from "./routes/research";
import { searchRoute } from "./routes/search";
import { taskRoute } from "./routes/task";
import { envelopeFail, envelopeOk } from "./utils/envelope";
import { ErrorCodes } from "./utils/errors";
import { newRequestId } from "./utils/id";

export { AtlasJob } from "./do/atlas-job";

const ASYNC_OPS = ["extract", "crawl", "research", "task"] as const;

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

v1.use("*", authMiddleware);

v1.route("/search", searchRoute);
v1.route("/fetch", fetchRoute);
v1.route("/extract", extractRoute);
v1.route("/research", researchRoute);
v1.route("/task", taskRoute);
v1.route("/crawl", crawlRoute);

const forwardToJob = async (c: any) => {
  const id = c.req.param("id") as string;
  const ns = c.env.ATLAS_JOB;
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
