---
name: atlas-onboarding
description:
  Deploy your own Atlas instance to Cloudflare Workers, wired to your Steel and Anthropic accounts.
  Use when the user wants to set up, deploy, or onboard to Atlas — typically right after they clone
  the repo and open it for the first time. Walks through wrangler login, wrangler.toml
  customization, R2 bucket creation, secret setup, deploy, and a smoke test.
user-invocable: true
allowed-tools: Bash, Read, Edit, AskUserQuestion, TaskCreate, TaskUpdate
---

# Atlas Deployment Guide

You are guiding the user through deploying their own Atlas instance to Cloudflare Workers. This is a
~5 minute interactive process; the user pastes API keys as we go and you script the rest.

Atlas is an OSS web-data API (search, fetch, extract, research, etc.) built on Cloudflare Workers +
Durable Objects, backed by Steel Browser for the actual web access and Anthropic Claude for the LLM
work. The user owns the deployment — keys, billing, data — and the surface mirrors Parallel.ai so
existing clients can migrate by switching baseURL.

## Before Starting

Use TaskCreate to track these phases:

1. Confirm required accounts & credentials are in hand
2. Local prerequisites (wrangler installed + logged in)
3. Customize wrangler.toml (pick deployment suffix)
4. Create R2 bucket
5. Set Steel API key
6. Set Anthropic API key
7. Deploy worker
8. Smoke test

Refuse to log any collected API keys back to the chat. After collecting a key with AskUserQuestion,
pipe it into `wrangler secret put` via stdin — do not echo it elsewhere.

## Phase 1: Prerequisites & Required Credentials

**Do this first, before any local checks or `wrangler` calls.** Atlas talks to three external
services. The user owns each account; we won't proceed until all three are ready, because we'd just
have to stop mid-deploy otherwise.

List what's needed, then use AskUserQuestion (multiSelect) to confirm. Frame it as a checklist —
don't collect the actual keys yet (we do that in Phases 4 and 5, right before `wrangler secret
put`), just confirm the user can produce each one when asked.

> Atlas needs three accounts. Before we start, confirm you have (or can create in the next few
> minutes):
>
> 1. **Cloudflare account** — free tier is fine. Workers + R2 must be enabled (R2 needs a credit
>    card on file, even on free tier). We'll use Wrangler's browser OAuth, so no API token needed.
> 2. **Steel account** with an API key from https://app.steel.dev → Settings → API Keys.
>    Free tier works for testing. Required permission: ability to create browser sessions
>    (default for new keys).
> 3. **Anthropic API key** from https://console.anthropic.com → API Keys. `sk-ant-…` format.
>    Make sure the key/workspace has credit available — `/research` and `/extract` will fail
>    with 402 otherwise.
>
> Also useful but optional:
>
> - A custom domain on Cloudflare if you want a non-`*.workers.dev` URL (can be added later)
> - A Steel residential proxy add-on if you'll hit sites with heavy anti-bot (can be added later)

AskUserQuestion (multiSelect=true) — one question with options for each account: "Cloudflare ready",
"Steel API key ready", "Anthropic API key ready". If any is unchecked, stop and tell the user to
finish the missing signup(s), then resume the skill. Do **not** proceed to Phase 2 until all three
are confirmed.

If the user pastes a key into chat at this stage, tell them to hold it — we'll collect it directly
into `wrangler secret put` in the relevant phase so it never lands in the conversation transcript.

## Phase 2: Local Prerequisites

Confirm the user is in the Atlas project root and that node_modules is installed.

```bash
test -f wrangler.toml && test -d node_modules && echo "ready" || echo "missing"
```

If `missing`, instruct user to run `npm install` first, then resume.

Check Wrangler login state:

```bash
npx wrangler whoami 2>&1 | tail -5
```

If the output indicates not authenticated, **do not try to log in automatically** — `wrangler login`
needs an interactive browser flow on the user's machine. Tell the user:

> Open a terminal in this directory and run:
>
> ```
> npx wrangler login
> ```
>
> A browser tab will open for Cloudflare OAuth. Once you see "Successfully logged in", come back and
> tell me you're done.

Wait for the user to confirm before continuing to Phase 3.

## Phase 3: Customize wrangler.toml

R2 bucket names are global within a Cloudflare account, and Worker names are per-account but
should still be unique within an org. We append a suffix to both so multiple users (or a user with
multiple deployments) don't collide.

Generate a default random suffix:

```bash
openssl rand -hex 3
```

Use AskUserQuestion to ask:

> What suffix should we append to your Atlas deployment? Letters and digits only, ≤24 chars. This
> becomes part of your Worker name (`atlas-<suffix>`) and R2 bucket name
> (`atlas-<suffix>-artifacts`).
>
> Options:
>
> - The generated random suffix `<hex>` (Recommended)
> - Their GitHub handle or company name
> - (Custom)

Read `wrangler.toml`, then Edit:

- `name = "atlas"` → `name = "atlas-<suffix>"`
- `bucket_name = "atlas-artifacts"` → `bucket_name = "atlas-<suffix>-artifacts"`

Show the user a diff (or just the two changed lines) for confirmation before moving on.

## Phase 4: Create R2 bucket

```bash
npx wrangler r2 bucket create atlas-<suffix>-artifacts
```

Handle outcomes:

- Success: continue
- `bucket already exists`: ask the user if they want to (a) reuse the existing bucket — fine if it's
  theirs — or (b) pick a different suffix and re-do Phase 3. Don't silently reuse.
- Auth error: re-run `wrangler whoami` and back to Phase 2

## Phase 5: Steel API Key

Tell the user:

> Atlas uses Steel Browser as its substrate — Steel handles the actual web fetching with real
> headless browsers (anti-bot, JS rendering, residential proxy if enabled).
>
> 1. Go to https://app.steel.dev (sign up if you don't have an account; free tier is fine for
>    testing)
> 2. Settings → API Keys → Create new key
> 3. Copy the key (starts with `sk_…` or similar)
> 4. Paste it below

Use AskUserQuestion with a single free-text question to collect the key (use "Other" for free text,
or design the question so the user types the key). After receiving:

```bash
printf '%s' '<STEEL_API_KEY>' | npx wrangler secret put STEEL_API_KEY
```

Do **not** echo the key back. Use `printf '%s'` (no trailing newline) rather than `echo` to avoid
adding stray whitespace into the secret.

If the user mentions they're running self-hosted Steel instead of Steel Cloud, tell them to also
add an env var to wrangler.toml after onboarding:

```toml
[vars]
STEEL_BASE_URL = "https://their-steel-host"
```

## Phase 6: Anthropic API Key

Tell the user:

> Atlas calls Claude for the LLM work (page summarization in `/research`, schema-constrained
> extraction in `/extract`, final report writing). You bring your own key.
>
> 1. Go to https://console.anthropic.com
> 2. Create a workspace if you don't have one (recommended — easier to track spend on this
>    deployment alone)
> 3. API Keys → Create Key (starts with `sk-ant-…`)
> 4. Paste it below

Collect with AskUserQuestion, then:

```bash
printf '%s' '<ANTHROPIC_API_KEY>' | npx wrangler secret put ANTHROPIC_API_KEY
```

## Phase 7: Deploy

```bash
npx wrangler deploy 2>&1 | tail -25
```

Parse the output for the deployed URL — it'll be something like
`https://atlas-<suffix>.<your-subdomain>.workers.dev`. Save it in a variable to use in Phase 8.

If deploy fails:

- "Durable Object migration" error → user has a stale wrangler. Run
  `npm install -D wrangler@latest` and retry.
- "Workers name conflict" → the suffix is taken in this account already. Back to Phase 3 with a
  different suffix.
- "R2 binding not found" → the bucket name in wrangler.toml doesn't match what we created in
  Phase 4. Verify and retry.

## Phase 8: Smoke test

Two checks: a sync endpoint (validates Steel binding) and an async endpoint (validates DO + LLM
binding).

### Sync test — /v1/search

```bash
curl -sS -X POST "<DEPLOY_URL>/v1/search" \
  -H 'Content-Type: application/json' \
  -d '{"query":"steel browser","limit":3}' | head -c 2000
```

Expect a non-empty `results` array. If empty:

- Anti-bot challenge — try `"engine":"bing"` instead of the default DDG
- Steel error — check `wrangler tail` (instruct user to open another terminal)

### Async test — /v1/research

```bash
JOB_ID=$(curl -sS -X POST "<DEPLOY_URL>/v1/research" \
  -H 'Content-Type: application/json' \
  -d '{"query":"what is Steel Browser","max_sources":3,"max_sub_questions":2}' \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")
echo "Job: $JOB_ID"
echo "Live: curl -N <DEPLOY_URL>/v1/research/$JOB_ID/stream"
echo "Poll: curl -sS <DEPLOY_URL>/v1/research/$JOB_ID | head -c 4000"
```

Tell the user to run the `curl -N` line in another terminal to watch the SSE stream live. Final
result lands when `event: completed` arrives (~1-3 min for `max_sources: 3`).

## Wrap-up

Once the smoke test passes, summarize for the user:

- Deployed URL
- The 4 working endpoints (`/v1/search`, `/v1/fetch`, `/v1/extract`, `/v1/research`)
- Where to find their secrets (`npx wrangler secret list`)
- How to redeploy on code changes (`npx wrangler deploy`)
- Where to view live logs (`npx wrangler tail`)
- Cost note: Steel Cloud charges per browser minute, Anthropic charges per token; this is a
  pay-per-use deployment — set budget alerts at console.anthropic.com and app.steel.dev.

## Error Handling

| Symptom                                                  | Fix                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `wrangler: command not found`                            | User skipped `npm install`; run it and re-try                      |
| Login flow stalls                                        | Instruct user to run `npx wrangler login` interactively themselves |
| R2 bucket name conflict                                  | Pick new suffix (Phase 3 redo)                                     |
| Worker name conflict in this account                     | Pick new suffix (Phase 3 redo)                                     |
| "new_sqlite_classes" unrecognized                        | Wrangler too old, `npm i -D wrangler@latest`                       |
| `/v1/search` returns `E_STEEL_UNAVAILABLE` (anti-bot)    | Use `"engine":"bing"` or `"engine":"ddg"` (default); Google is hard |
| `/v1/research` job stuck in "running"                    | `wrangler tail` to see the alarm logs; usually an LLM rate limit  |
| `STEEL_API_KEY` not picked up                            | `wrangler secret list` to verify; if missing, re-run Phase 5       |
| User missing one of Cloudflare/Steel/Anthropic accounts  | Stop at Phase 1; have them complete signup before resuming         |
| Anthropic key returns 402 in smoke test                  | Workspace has no credit — top up at console.anthropic.com → Billing |

## Important Notes

- **Never log secrets to chat.** After collecting via AskUserQuestion, pipe to `wrangler secret put`
  and discard from your working memory.
- **Don't auto-run `wrangler login`** — it requires the user's browser. Always hand it off.
- **The deploy is reversible**: `npx wrangler delete` removes the Worker. R2 bucket and secrets can
  be cleaned via dashboard or CLI.
