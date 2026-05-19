# Atlas

[![CI](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-experiments/atlas/actions/workflows/ci.yml)

OSS web-data API — search, fetch, extract, research — running on Cloudflare Workers, backed by
[Steel Browser](https://steel.dev).

```
            Cloudflare Workers + Durable Objects (SQLite)
                              │
                              ▼
                Steel Browser  ─────►  the real web
                              │
                              ▼
                       Anthropic Claude
```

## Deploy in 5 minutes

The fastest path: clone, open in [Claude Code](https://claude.com/claude-code), and run the bundled
onboarding skill.

```bash
git clone https://github.com/steel-experiments/atlas
cd atlas
npm install
claude  # or open the folder in your Claude Code IDE
```

Then in Claude Code:

```
/atlas-onboarding
```

The skill walks you through (~5 min):

1. Cloudflare login + R2 bucket
2. Atlas bearer token + Steel API key + Anthropic API key (you bring your own)
3. `wrangler deploy`
4. Smoke test against your live URL

## Manual deploy (no Claude Code)

```bash
# 1. Cloudflare auth
npx wrangler login

# 2. Pick a deployment suffix (lowercase alphanum, ≤24 chars)
SUFFIX=mydeploy
sed -i '' "s/name = \"atlas\"/name = \"atlas-${SUFFIX}\"/" wrangler.toml
sed -i '' "s/bucket_name = \"atlas-artifacts\"/bucket_name = \"atlas-${SUFFIX}-artifacts\"/" wrangler.toml

# 3. R2 bucket
npx wrangler r2 bucket create atlas-${SUFFIX}-artifacts

# 4. Secrets
printf '%s' "your-shared-token" | npx wrangler secret put ATLAS_API_KEY
printf '%s' "sk_..." | npx wrangler secret put STEEL_API_KEY       # https://app.steel.dev
printf '%s' "sk-ant-..." | npx wrangler secret put ANTHROPIC_API_KEY  # https://console.anthropic.com

# 5. Deploy
npx wrangler deploy
```

## Endpoints

| Method | Path                             | Mode   | Returns                                          |
| ------ | -------------------------------- | ------ | ------------------------------------------------ |
| POST   | `/v1/search`                     | sync   | SERP results (DDG default, Bing/Google opt-in)   |
| POST   | `/v1/fetch`                      | sync   | URL → markdown                                   |
| POST   | `/v1/extract`                    | async  | URLs + JSON schema → structured data + citations |
| POST   | `/v1/research`                   | async  | Query → cited markdown report                    |
| POST   | `/v1/crawl`                      | async  | Site crawl → pages persisted to R2, paginated    |
| GET    | `/v1/{op}/{id}`                  | —      | Job status + result when complete                |
| GET    | `/v1/{op}/{id}/stream`           | —      | SSE live progress (Last-Event-ID supported)      |
| DELETE | `/v1/{op}/{id}`                  | —      | Cancel running job                               |

## API docs

Every deployment serves an OpenAPI 3.1 document and an interactive Scalar reference:

```bash
export ATLAS_URL="https://atlas-yourdeploy.workers.dev"
export ATLAS_API_KEY="your-shared-token"

open "$ATLAS_URL/docs"
curl -s "$ATLAS_URL/openapi.json" | jq '.info'
```

`/docs` and `/openapi.json` are public. Every `/v1/*` API call requires:
`Authorization: Bearer $ATLAS_API_KEY`.

### Conventions

- **Authorization**: every `/v1/*` call needs `Authorization: Bearer $ATLAS_API_KEY`.
- **Proxy default is OFF**: `use_proxy` defaults to `false` on every endpoint. Steel's residential
  proxy is a paid add-on; flip to `true` per-request only when the target site blocks the default
  egress (`{"use_proxy": true}`).
- **Async caps**: `/v1/extract` accepts up to 50 URLs per submission; `/v1/crawl` up to 10 000
  pages.
- **Idempotency-Key**: async POSTs (`extract`, `research`, `crawl`) accept an optional
  `Idempotency-Key: <≤255 printable ASCII>` header. Same key + same body → returns the existing job
  (200 instead of 202). Same key + different body → `409 E_IDEMPOTENCY_CONFLICT`. Idempotency lasts
  until the job is reaped (see below).
- **Job TTL**: 7 days after a job reaches a terminal state (`completed` / `failed` / `cancelled`)
  the Durable Object self-wipes — SQLite cleared, R2 crawl artifacts deleted. After that,
  `GET /v1/{op}/{id}` returns `404 E_JOB_NOT_FOUND`. Pull results before the deadline.

## API examples

The examples below assume `ATLAS_URL`, `ATLAS_API_KEY`, and `jq` are available in your shell.

### Search

```bash
curl -s "$ATLAS_URL/v1/search" \
  -H "Authorization: Bearer $ATLAS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Cloudflare Durable Objects SQLite",
    "limit": 5,
    "engine": "ddg"
  }' | jq
```

### Fetch

```bash
curl -s "$ATLAS_URL/v1/fetch" \
  -H "Authorization: Bearer $ATLAS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://developers.cloudflare.com/durable-objects/",
    "format": "markdown"
  }' | jq '.data | {url, title, status_code, content_chars: (.content | length)}'
```

### Submit an async extraction

```bash
JOB_ID=$(
  curl -s "$ATLAS_URL/v1/extract" \
    -H "Authorization: Bearer $ATLAS_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "urls": ["https://developers.cloudflare.com/durable-objects/"],
      "schema": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "key_features": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": ["summary", "key_features"]
      }
    }' | jq -r '.data.id'
)

echo "$JOB_ID"
```

### Poll an async job

```bash
while true; do
  status_json=$(
    curl -s "$ATLAS_URL/v1/extract/$JOB_ID" \
      -H "Authorization: Bearer $ATLAS_API_KEY"
  )

  echo "$status_json" | jq '.data | {status, progress}'

  status=$(echo "$status_json" | jq -r '.data.status')
  case "$status" in
    completed|failed|cancelled) break ;;
  esac

  sleep 2
done

echo "$status_json" | jq '.data.result'
```

### Stream progress with SSE

```bash
curl -N "$ATLAS_URL/v1/extract/$JOB_ID/stream" \
  -H "Authorization: Bearer $ATLAS_API_KEY"
```

If the connection drops, resume after the last event id you received:

```bash
curl -N "$ATLAS_URL/v1/extract/$JOB_ID/stream" \
  -H "Authorization: Bearer $ATLAS_API_KEY" \
  -H "Last-Event-ID: 12"
```

### Retry safely with Idempotency-Key

```bash
curl -i "$ATLAS_URL/v1/research" \
  -H "Authorization: Bearer $ATLAS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: research-cloudflare-do-sqlite-v1" \
  -d '{
    "query": "What changed when Cloudflare Durable Objects added SQLite?",
    "max_sub_questions": 3,
    "max_sources": 8
  }'
```

Retrying the same key with the same body returns the existing job (`200`). Reusing the same key with
a different body returns `409 E_IDEMPOTENCY_CONFLICT`.

### Crawl and paginate pages

```bash
CRAWL_ID=$(
  curl -s "$ATLAS_URL/v1/crawl" \
    -H "Authorization: Bearer $ATLAS_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "url": "https://developers.cloudflare.com/durable-objects/",
      "limit": 25,
      "crawlEntireDomain": true,
      "maxDiscoveryDepth": 1
    }' | jq -r '.data.id'
)

curl -s "$ATLAS_URL/v1/crawl/$CRAWL_ID?offset=0&limit=10" \
  -H "Authorization: Bearer $ATLAS_API_KEY" \
  | jq '.data | {status, summary, pagination, pages: [.pages[] | {url, status, title, r2_key}]}'

curl -s "$ATLAS_URL/v1/crawl/$CRAWL_ID?offset=10&limit=10" \
  -H "Authorization: Bearer $ATLAS_API_KEY" \
  | jq '.data.pagination'
```

## Architecture

- **Workers (Hono)** — sync HTTP entry; routes async submissions to the right DO instance via
  `idFromName(job_id)`.
- **Durable Object `AtlasJob`** (SQLite-backed) — one per async job. Holds plan, sources, excerpts,
  SSE event log. Crash-resumable via persisted state + alarm-driven step loop.
- **R2** — crawl page markdown artifacts.
- **Steel** — every browser interaction. The substrate this template is designed around.
- **Anthropic Claude** — LLM work (Haiku for per-page summarization and extraction, Sonnet for the
  final research report writer).

## License

MIT.
