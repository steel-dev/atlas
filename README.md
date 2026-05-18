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
