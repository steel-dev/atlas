import { z } from "zod";
import * as S from "./schemas";

const VERSION = "0.0.1";

function toJS(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

function jsonBody(schema: z.ZodTypeAny) {
  return {
    required: true,
    content: { "application/json": { schema: toJS(schema) } },
  };
}

function ok(schema: z.ZodTypeAny, description: string) {
  return {
    description,
    content: { "application/json": { schema: toJS(schema) } },
  };
}

const errorEnvelopeSchema = toJS(S.ErrorEnvelope);

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: errorEnvelopeSchema } },
});

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header" as const,
  required: false,
  schema: { type: "string", maxLength: 255 },
  description:
    "Same key + same body returns the existing job (200). Same key + different body → 409.",
};

const pathIdParam = {
  name: "id",
  in: "path" as const,
  required: true,
  schema: { type: "string" },
};

const sseStreamResponse = {
  "200": {
    description:
      "Server-sent event stream. Resume mid-stream by sending `Last-Event-ID`.",
    content: { "text/event-stream": { schema: { type: "string" } } },
  },
  "404": errorResponse("Job not found / reaped"),
};

function asyncPostResponses() {
  return {
    "200": ok(
      S.okEnvelope(S.JobSubmissionData),
      "Existing job replayed (idempotent)",
    ),
    "202": ok(S.okEnvelope(S.JobSubmissionData), "Job accepted"),
    "401": errorResponse("Unauthorized"),
    "409": errorResponse("Idempotency-Key conflict"),
    "422": errorResponse("Validation error"),
    "500": errorResponse("Internal error"),
  };
}

function jobGetResponses(jobStatus: z.ZodTypeAny) {
  return {
    "200": ok(S.okEnvelope(jobStatus), "Job state"),
    "401": errorResponse("Unauthorized"),
    "404": errorResponse("Job not found / reaped"),
  };
}

function buildOpenAPIDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Atlas",
      version: VERSION,
      description:
        "OSS web-data API on Cloudflare Workers, backed by Steel Browser.\n\n" +
        "All `/v1/*` endpoints require `Authorization: Bearer $ATLAS_API_KEY`.",
      license: { name: "MIT" },
    },
    servers: [{ url: "/", description: "This deployment" }],
    tags: [
      { name: "Sync", description: "Synchronous endpoints (results inline)" },
      { name: "Async", description: "Submit async jobs (extract / research / crawl)" },
      { name: "Jobs", description: "Async job status, stream, and cancel" },
      { name: "Meta", description: "Service metadata" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Provide your ATLAS_API_KEY as the bearer token.",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/": {
        get: {
          tags: ["Meta"],
          summary: "Service info",
          operationId: "root",
          security: [],
          responses: {
            "200": {
              description: "Service metadata",
              content: {
                "application/json": {
                  schema: toJS(
                    S.okEnvelope(
                      z.object({
                        name: z.string(),
                        version: z.string(),
                        docs: z.string(),
                      }),
                    ),
                  ),
                },
              },
            },
          },
        },
      },
      "/v1/search": {
        post: {
          tags: ["Sync"],
          summary: "Web search",
          operationId: "search",
          requestBody: jsonBody(S.SearchRequest),
          responses: {
            "200": ok(S.okEnvelope(S.SearchResponseData), "Search results"),
            "401": errorResponse("Unauthorized"),
            "422": errorResponse("Validation error"),
            "502": errorResponse("Upstream search engine failed"),
            "504": errorResponse("Upstream timeout"),
          },
        },
      },
      "/v1/fetch": {
        post: {
          tags: ["Sync"],
          summary: "Fetch a URL → markdown / HTML / readability",
          operationId: "fetch",
          requestBody: jsonBody(S.FetchRequest),
          responses: {
            "200": ok(S.okEnvelope(S.FetchResponseData), "Fetched page"),
            "401": errorResponse("Unauthorized"),
            "422": errorResponse("Validation error"),
            "502": errorResponse("Upstream fetch failed / anti-bot block"),
            "504": errorResponse("Upstream timeout"),
          },
        },
      },
      "/v1/extract": {
        post: {
          tags: ["Async"],
          summary: "Submit structured-extraction job",
          description:
            "URLs + JSON schema → structured data with per-field citations. Up to 50 URLs.",
          operationId: "extractSubmit",
          parameters: [idempotencyHeader],
          requestBody: jsonBody(S.ExtractRequest),
          responses: asyncPostResponses(),
        },
      },
      "/v1/extract/{id}": {
        get: {
          tags: ["Jobs"],
          summary: "Get extract job status / result",
          operationId: "extractGet",
          parameters: [pathIdParam],
          responses: jobGetResponses(S.ExtractJobStatusData),
        },
        delete: {
          tags: ["Jobs"],
          summary: "Cancel extract job",
          operationId: "extractCancel",
          parameters: [pathIdParam],
          responses: jobGetResponses(S.ExtractJobStatusData),
        },
      },
      "/v1/extract/{id}/stream": {
        get: {
          tags: ["Jobs"],
          summary: "Stream extract progress (SSE)",
          operationId: "extractStream",
          parameters: [
            pathIdParam,
            {
              name: "Last-Event-ID",
              in: "header" as const,
              required: false,
              schema: { type: "string" },
              description: "Resume after this event sequence number.",
            },
          ],
          responses: sseStreamResponse,
        },
      },
      "/v1/research": {
        post: {
          tags: ["Async"],
          summary: "Submit research job",
          description:
            "Query → cited markdown report. Multi-hop refinement (max_hops) and citation verification (verify_threshold) enabled by default.",
          operationId: "researchSubmit",
          parameters: [idempotencyHeader],
          requestBody: jsonBody(S.ResearchRequest),
          responses: asyncPostResponses(),
        },
      },
      "/v1/research/{id}": {
        get: {
          tags: ["Jobs"],
          summary: "Get research job status / result",
          operationId: "researchGet",
          parameters: [pathIdParam],
          responses: jobGetResponses(S.ResearchJobStatusData),
        },
        delete: {
          tags: ["Jobs"],
          summary: "Cancel research job",
          operationId: "researchCancel",
          parameters: [pathIdParam],
          responses: jobGetResponses(S.ResearchJobStatusData),
        },
      },
      "/v1/research/{id}/stream": {
        get: {
          tags: ["Jobs"],
          summary: "Stream research progress (SSE)",
          operationId: "researchStream",
          parameters: [
            pathIdParam,
            {
              name: "Last-Event-ID",
              in: "header" as const,
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: sseStreamResponse,
        },
      },
      "/v1/crawl": {
        post: {
          tags: ["Async"],
          summary: "Submit site crawl",
          description:
            "Crawl up to 10 000 pages. Markdown artifacts persist to R2; pages list paginated via `?offset=&limit=`.",
          operationId: "crawlSubmit",
          parameters: [idempotencyHeader],
          requestBody: jsonBody(S.CrawlRequest),
          responses: asyncPostResponses(),
        },
      },
      "/v1/crawl/{id}": {
        get: {
          tags: ["Jobs"],
          summary: "Get crawl job status / pages",
          operationId: "crawlGet",
          parameters: [
            pathIdParam,
            {
              name: "offset",
              in: "query" as const,
              required: false,
              schema: { type: "integer", minimum: 0 },
            },
            {
              name: "limit",
              in: "query" as const,
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
          ],
          responses: jobGetResponses(S.CrawlJobStatusData),
        },
        delete: {
          tags: ["Jobs"],
          summary: "Cancel crawl job",
          operationId: "crawlCancel",
          parameters: [pathIdParam],
          responses: jobGetResponses(S.CrawlJobStatusData),
        },
      },
      "/v1/crawl/{id}/stream": {
        get: {
          tags: ["Jobs"],
          summary: "Stream crawl progress (SSE)",
          operationId: "crawlStream",
          parameters: [
            pathIdParam,
            {
              name: "Last-Event-ID",
              in: "header" as const,
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: sseStreamResponse,
        },
      },
    },
  };
}

let cached: ReturnType<typeof buildOpenAPIDocument> | null = null;

export function getOpenAPIDocument() {
  if (!cached) cached = buildOpenAPIDocument();
  return cached;
}

export const SCALAR_HTML = `<!doctype html>
<html>
  <head>
    <title>Atlas API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body{margin:0}</style>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
