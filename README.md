# Embedding Worker

Cloudflare Worker — multi-tenant text embedding service via OpenRouter.
Phase 1: text only. Phase 2: image + doc.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Client / CF Function                      │
│         POST /embeddings/text                               │
│         Authorization: Bearer sk_<48hex>                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  embedding-worker (CF Worker)                │
│                                                             │
│  index.ts                                                   │
│  ├── CORS preflight                                         │
│  ├── Content-Length guard (≤ 1MB)                           │
│  ├── /health          → jsonOk                              │
│  ├── /admin/*         → authenticateAdmin (X-Admin-Key)     │
│  │                       └── admin.ts                       │
│  │                           ├── POST   /admin/tenant       │
│  │                           ├── GET    /admin/tenant       │
│  │                           ├── GET    /admin/tenants      │
│  │                           └── DELETE /admin/tenant       │
│  └── /embeddings/* → authenticate (Bearer token)           │
│                          ├── auth.ts                        │
│                          │   sha256(token) → KV lookup      │
│                          │   → tenant config                │
│                          └── handlers/                      │
│                              ├── text.ts   (phase 1 ✅)     │
│                              ├── image.ts  (phase 2 🔜 501) │
│                              └── doc.ts    (phase 2 🔜 501) │
└──────────┬──────────────────────────┬───────────────────────┘
           │                          │
           ▼                          ▼
┌──────────────────┐      ┌───────────────────────┐
│  EMBEDDING_KV    │      │  OpenRouter API        │
│                  │      │  /v1/embeddings        │
│  tenant:<id>     │      │  text-embedding-3-small│
│  api_keys:<hash> │      │  timeout: 10s          │
└──────────────────┘      │  retry: 1x on 5xx      │
                          └───────────────────────┘
```

---

## Stack

- Runtime: Cloudflare Workers (TypeScript)
- KV binding: `EMBEDDING_KV` — tenant config, API keys
- Provider: OpenRouter
- Local dev port: `9004`

---

## File Structure

```
src/
├── index.ts           — entry, router, CORS, body size guard
├── types.ts           — Env, TenantConfig, ApiKeyRecord, RequestContext, error classes
├── constants.ts       — limits, timeouts, error codes
├── providers.ts       — model configs, pricing, resolveModel()
├── auth.ts            — Bearer token → sha256 → KV → tenant
├── admin.ts           — all /admin/* handlers
├── handlers/
│   ├── text.ts        — POST /v1/embeddings/text (full)
│   ├── image.ts       — POST /v1/embeddings/image (501 stub)
│   └── doc.ts         — POST /v1/embeddings/doc (501 stub)
└── utils/
    ├── hash.ts        — sha256 via WebCrypto
    └── response.ts    — jsonOk, jsonError, handleError, getCorsHeaders
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `ADMIN_KEY` | Protects all `/admin/*` routes |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `VOYAGE_API_KEY` | Voyage AI API key (phase 2) |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins |
| `ENVIRONMENT` | `local` / `development` / `staging` / `production` |

Set via `.dev.vars` locally. Use `wrangler secret put <VAR>` for deployed envs.

---

## KV Namespace — `EMBEDDING_KV`

```
api_keys:<sha256(token)>  → { tenant_id, created_at }
tenant:<tenant_id>        → { name, created_at }
```

- Token never stored plain — only SHA-256 hash
- Deleting a tenant leaves orphan key records — they fail auth naturally (tenant lookup returns null)

---

## Auth Flow

```
Bearer sk_<48hex>
  → regex validate: ^sk_[a-f0-9]{48}$
  → sha256(token)
  → KV get api_keys:<hash> → { tenant_id }
  → KV get tenant:<tenant_id> → TenantConfig
  → RequestContext
```

Auth is the primary protection — API key is server-side only (Cloudflare Pages env var), never exposed to the browser.

---

## CORS

Allowed origins are configured per environment via `ALLOWED_ORIGINS` in `wrangler.toml` (comma-separated string) and `.dev.vars` for local:

| Environment | Origins |
|---|---|
| `local` | `http://localhost:5173`, `http://localhost:8788`, `http://127.0.0.1:5173`, `http://127.0.0.1:8788` |
| `development` | `https://dev.skillpassports.com` |
| `staging` | `https://stag.skillpassports.com` |
| `production` | `https://skillpassport.com`, `https://www.skillpassport.com` |

Origin is only reflected if it matches the allowlist — no wildcard fallback.

---

## Constants

```typescript
MAX_INPUT_CHARS = 32000       // per string item
MAX_BATCH_SIZE = 10           // max array items
MAX_REQUEST_BODY_SIZE = 1_000_000  // 1MB
OPENROUTER_TIMEOUT_MS = 10000
RETRY_DELAY_MS = 500
MAX_RETRIES = 1               // retry once on 5xx only
CORS_MAX_AGE = 86400
```

---

## Endpoints

### GET /health — public

```json
{ "status": "ok", "version": "1.0.0", "environment": "production", "timestamp": "..." }
```

---

### POST /embeddings/text

Auth: `Authorization: Bearer sk_<48hex>`

Optional: `X-Request-ID: <your-id>` — alphanumeric + `_-`, max 64 chars. Echoed back as `request_id`.

Accepted input forms:
```json
{ "input": "raw string" }
{ "input": ["string one", "string two"] }
{ "input": { "title": "Engineer", "skills": ["AI"] } }
```

Objects and non-string array items are `JSON.stringify`'d internally.

Response:
```json
{
  "success": true,
  "embedding": [0.023, ...],
  "model": "openai/text-embedding-3-small",
  "dimensions": 1536,
  "usage": { "prompt_tokens": 12, "estimated_cost_usd": "0.000000" },
  "request_id": "req_abc123_def456",
  "latency_ms": 210
}
```

Note: for batch input (array), only the first item's embedding is returned.

---

### POST /embeddings/image — 501 stub

### POST /embeddings/doc — 501 stub

---

### POST /admin/tenant — X-Admin-Key required

Creates tenant + API key.

Request:
```json
{ "id": "skillpassport", "name": "Skill Passport" }
```

`id` is lowercased and non-alphanumeric chars replaced with `-`.

Response (201):
```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "api_key": "sk_2f84c0f8...",
  "created_at": "..."
}
```

`api_key` returned ONCE — never stored plain text. Save it immediately.

---

### GET /admin/tenant?id=xxx — X-Admin-Key required

Response:
```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "config": { "name": "Skill Passport", "created_at": "..." }
}
```

---

### GET /admin/tenants — X-Admin-Key required

Response:
```json
{
  "success": true,
  "tenants": [
    { "tenant_id": "skillpassport", "name": "Skill Passport", "created_at": "..." }
  ],
  "total": 1
}
```

---

### DELETE /admin/tenant?id=xxx — X-Admin-Key required

Response:
```json
{ "success": true, "message": "Tenant 'skillpassport' deleted" }
```

Existing API keys for the deleted tenant fail auth naturally (tenant KV record gone).

---

## Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Bad/missing Bearer token or admin key |
| `INVALID_INPUT` | 400 | Validation failure |
| `PROVIDER_ERROR` | 502 | OpenRouter failed after retry |
| `INTERNAL_ERROR` | 500 | Unexpected error |
| `NOT_FOUND` | 404 | Route not found |
| `NOT_IMPLEMENTED` | 501 | Image/doc endpoints (phase 2) |
| `TENANT_EXISTS` | 409 | Duplicate tenant ID |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method on admin route |

Error shape:
```json
{ "success": false, "errorCode": "UNAUTHORIZED", "message": "...", "request_id": "req_..." }
```

---

## Local Dev

```bash
cd cloudflare-workers/embedding-worker
npm run dev
# http://localhost:9004
```

`.dev.vars` required:
```
ADMIN_KEY=ew-local-admin-key-change-me
OPENROUTER_API_KEY=sk-or-...
ENVIRONMENT=local
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8788,http://127.0.0.1:5173,http://127.0.0.1:8788
```

Create a tenant:
```bash
curl -X POST http://localhost:9004/admin/tenant \
  -H "X-Admin-Key: ew-local-admin-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"id":"test","name":"Test Tenant"}'
```

Embed text:
```bash
curl -X POST http://localhost:9004/embeddings/text \
  -H "Authorization: Bearer sk_<key from above>" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world"}'
```

---

## Deploy

```bash
# Set secrets
wrangler secret put ADMIN_KEY
wrangler secret put OPENROUTER_API_KEY

# Deploy
npx wrangler deploy
```

For named envs (dev/staging/production), replace `REPLACE_WITH_*_KV_ID` in `wrangler.toml` with real KV namespace IDs first:
```bash
npx wrangler kv namespace create EMBEDDING_KV --env development
npx wrangler deploy --env development
```

---

## Phase 2 — Image + Doc

When ready:
- `handlers/image.ts` — base64 image → OpenRouter multimodal model
- `handlers/doc.ts` — PDF/DOCX/PPTX → `env.AI.toMarkdown()` text extraction → embed
- Add `[ai] binding = "AI"` to `wrangler.toml`
- Add `AI: Ai` to `Env` in `types.ts`
- No routing changes needed — endpoints already exist as stubs
