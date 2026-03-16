# Embedding Worker

A multi-tenant embedding API built on Cloudflare Workers. Converts text, images, and documents into vector embeddings using Voyage AI. Designed for the SkillPassports platform.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Request                           │
│   POST /embeddings/text | /embeddings/image | /embeddings/doc   │
│   Authorization: Bearer sk_<48hex>                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  embedding-worker (CF Worker)                    │
│                                                                 │
│  index.ts                                                       │
│  ├── CORS preflight (OPTIONS → 204)                             │
│  ├── Content-Length guard                                       │
│  ├── GET  /health              → public                         │
│  ├── ANY  /admin/*             → authenticateAdmin (X-Admin-Key)│
│  │                                └── admin.ts                  │
│  │                                    ├── POST   /admin/tenant  │
│  │                                    ├── GET    /admin/tenant  │
│  │                                    ├── GET    /admin/tenants │
│  │                                    └── DELETE /admin/tenant  │
│  └── POST /embeddings/*        → authenticate (Bearer token)   │
│                                    ├── auth.ts                  │
│                                    │   sha256(token) → KV       │
│                                    │   → TenantConfig           │
│                                    └── handlers/                │
│                                        ├── text.ts  ✅          │
│                                        ├── image.ts ✅          │
│                                        └── doc.ts   ✅          │
└──────────┬───────────────────────────────┬──────────────────────┘
           │                               │
           ▼                               ▼
┌──────────────────┐         ┌─────────────────────────────────┐
│  EMBEDDING_KV    │         │  providers.ts                   │
│                  │         │                                 │
│  tenant:<id>     │         │  Voyage AI                      │
│  api_keys:<hash> │         │  ├── /v1/embeddings             │
└──────────────────┘         │  │   model: voyage-3            │
                             │  │   used by: text, doc         │
                             │  └── /v1/multimodalembeddings   │
                             │      model: voyage-multimodal-3.5│
                             │      used by: image             │
                             │                                 │
                             │  doc handler also uses:         │
                             │  env.AI.toMarkdown (CF Workers AI)│
                             └─────────────────────────────────┘
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| KV Store | Cloudflare KV (`EMBEDDING_KV`) |
| Text & Doc Embeddings | Voyage AI — `voyage-3` |
| Image Embeddings | Voyage AI — `voyage-multimodal-3.5` |
| Doc → Markdown | Cloudflare Workers AI `toMarkdown` |
| Local dev port | `9004` |

---

## File Structure

```
src/
├── index.ts           — entry point, router, CORS, body size guard
├── types.ts           — Env, interfaces, error classes
├── constants.ts       — all limits, timeouts, error codes
├── providers.ts       — Voyage AI config, model resolvers, HTTP callers
├── auth.ts            — Bearer token auth + admin key auth
├── admin.ts           — /admin/* route handlers
├── handlers/
│   ├── text.ts        — POST /embeddings/text
│   ├── image.ts       — POST /embeddings/image
│   └── doc.ts         — POST /embeddings/doc
└── utils/
    ├── hash.ts        — sha256 via Web Crypto API
    └── response.ts    — jsonOk, jsonError, handleError, getCorsHeaders
```

---

## Provider Design

All provider HTTP logic lives exclusively in `providers.ts`. Handlers never touch endpoints, auth headers, or request shapes directly.

```
handlers/text.ts  ──→  callTextProvider()  ──→  VOYAGE.textEndpoint
handlers/doc.ts   ──→  callTextProvider()  ──→  VOYAGE.textEndpoint
handlers/image.ts ──→  callImageProvider() ──→  VOYAGE.imageEndpoint
```

To swap providers (e.g. Voyage → Google Gemini), only edit `providers.ts`:
- Update the `VOYAGE` config object (name, endpoints, models, pricing)
- Update the fetch body/response shape in `callTextProvider` / `callImageProvider`

No handler files need to change.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `ADMIN_KEY` | Secret | Protects all `/admin/*` routes |
| `VOYAGE_API_KEY` | Secret | Voyage AI API key (text + image + doc) |
| `ALLOWED_ORIGINS` | `wrangler.toml` vars | Comma-separated CORS allowlist |
| `ENVIRONMENT` | `wrangler.toml` vars | `local` / `development` / `staging` / `production` |

Secrets are set via `.dev.vars` locally and `wrangler secret put` for deployed environments.

---

## KV Data Model

Namespace: `EMBEDDING_KV`

```
api_keys:<sha256(token)>  →  { tenant_id: string, created_at: string }
tenant:<tenant_id>        →  { name: string, created_at: string }
```

- Raw API tokens are never stored — only their SHA-256 hash
- Deleting a tenant leaves orphan `api_keys:` entries — they fail auth naturally since the tenant record is gone

---

## Auth Flow

**Tenant auth (embedding routes):**
```
Authorization: Bearer sk_<48 lowercase hex chars>
  → validate format: /^sk_[a-f0-9]{48}$/
  → sha256(token)
  → KV get api_keys:<hash>  → { tenant_id }
  → KV get tenant:<id>      → TenantConfig
  → RequestContext { tenantId, tenant, requestId, startTime }
```

**Admin auth:**
```
X-Admin-Key: <value>
  → compare against env.ADMIN_KEY (string equality)
```

---

## CORS

Origins are configured per environment in `wrangler.toml` via `ALLOWED_ORIGINS`. Only listed origins are reflected — no wildcard fallback.

| Environment | Allowed Origins |
|---|---|
| local | `http://localhost:5173`, `http://localhost:8788`, `http://127.0.0.1:5173`, `http://127.0.0.1:8788` |
| development | `https://dev.skillpassports.com` |
| staging | `https://stag.skillpassports.com` |
| production | `https://skillpassport.com`, `https://www.skillpassport.com` |

---

## Limits & Constants

```typescript
// Text
MAX_INPUT_CHARS          = 32_000      // per string item
MAX_BATCH_SIZE           = 10          // max items in array input
MAX_REQUEST_BODY_SIZE    = 1_000_000   // 1MB

// Image
MAX_IMAGE_BATCH_SIZE          = 5
MAX_IMAGE_REQUEST_BODY_SIZE   = 20_000_000   // 20MB
ALLOWED_IMAGE_MEDIA_TYPES     = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']

// Doc
MAX_DOC_REQUEST_BODY_SIZE     = 10_000_000   // 10MB
ALLOWED_DOC_TYPES             = PDF, Word (.docx), Excel (.xlsx)

// Provider
VOYAGE_TIMEOUT_MS    = 30_000   // 30s timeout for all Voyage calls
RETRY_DELAY_MS       = 500
MAX_RETRIES          = 1        // retry once on 5xx only
```

---

## Voyage AI Models

| Model | Used For | Dimensions | Cost per 1M tokens |
|---|---|---|---|
| `voyage-3` | text, doc | 1024 | $0.06 |
| `voyage-3-lite` | text (cheaper) | 512 | $0.02 |
| `voyage-multimodal-3.5` | image | 1024 | $0.12 |
| `voyage-multimodal-3` | image (legacy) | 1024 | $0.12 |

---

## API Reference

### GET /health

Public. No auth required.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production",
  "timestamp": "2026-03-16T08:00:00.000Z"
}
```

---

### POST /embeddings/text

Auth: `Authorization: Bearer sk_<48hex>`

Accepted `input` formats:
```json
{ "input": "a plain string" }
{ "input": ["string one", "string two"] }
{ "input": { "any": "object" } }
```

Objects and non-string array items are `JSON.stringify`'d before embedding. Max 10 items per batch, max 32,000 chars per item.

Response:
```json
{
  "success": true,
  "embedding": [0.023, -0.041, ...],
  "model": "voyage-3",
  "dimensions": 1024,
  "usage": {
    "total_tokens": 12,
    "estimated_cost_usd": "0.000001"
  },
  "request_id": "req_abc123_def456",
  "latency_ms": 210
}
```

---

### POST /embeddings/image

Auth: `Authorization: Bearer sk_<48hex>`

**Single image — URL:**
```json
{
  "input": {
    "type": "url",
    "data": "https://example.com/image.jpg"
  }
}
```

**Single image — base64:**
```json
{
  "input": {
    "type": "base64",
    "data": "<raw base64, no data URI prefix>",
    "mediaType": "image/jpeg"
  }
}
```

**Batch (up to 5 items):**
```json
{
  "input": [
    { "type": "url", "data": "https://example.com/1.jpg" },
    { "type": "base64", "data": "...", "mediaType": "image/png" }
  ]
}
```

Single input response:
```json
{
  "success": true,
  "embedding": [0.013, -0.057, ...],
  "dimensions": 1024,
  "model": "voyage-multimodal-3.5",
  "usage": {
    "total_tokens": 89,
    "estimated_cost_usd": "0.000011"
  },
  "request_id": "req_abc123_def456",
  "latency_ms": 691
}
```

Batch response returns `embeddings` array instead of `embedding`:
```json
{
  "success": true,
  "embeddings": [
    { "index": 0, "embedding": [...], "dimensions": 1024 },
    { "index": 1, "embedding": [...], "dimensions": 1024 }
  ],
  "model": "voyage-multimodal-3.5",
  ...
}
```

Image limits (enforced by Voyage):
- Max 20MB per image
- Max 16 million pixels (~4000×4000)
- Supported formats: JPEG, PNG, WEBP, GIF, BMP
- Every 560 pixels = 1 token, max 32,000 tokens per input
- URL inputs: host must return a `content-length` header (Voyage requirement since Dec 8 2025)

---

### POST /embeddings/doc

Auth: `Authorization: Bearer sk_<48hex>`

Accepts a base64-encoded document. Internally converts it to markdown via Cloudflare Workers AI `toMarkdown`, then embeds the extracted text using Voyage `voyage-3`.

Supported document types:

| Type | mimeType |
|---|---|
| PDF | `application/pdf` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |

Request:
```json
{
  "input": {
    "mimeType": "application/pdf",
    "data": "<base64 encoded file content>",
    "filename": "resume.pdf"
  }
}
```

`filename` is optional — defaults to `document.<ext>` if omitted.

Response:
```json
{
  "success": true,
  "embedding": [0.037, -0.077, ...],
  "model": "voyage-3",
  "dimensions": 1024,
  "document": {
    "filename": "resume.pdf",
    "mimeType": "application/pdf",
    "type": "PDF",
    "extracted_chars": 8420,
    "truncated": false
  },
  "usage": {
    "total_tokens": 2100,
    "estimated_cost_usd": "0.000126"
  },
  "request_id": "req_abc123_def456",
  "latency_ms": 3200
}
```

`truncated: true` means the extracted text exceeded 32,000 chars and was cut off before embedding. The first 32,000 chars are used.

Doc extraction notes:
- DOCX files produce better markdown than PDFs — tables are preserved as proper markdown tables
- PDFs with complex table layouts may lose table structure during extraction (text is still captured)
- Excel files are converted to markdown tables per sheet

---

### POST /admin/tenant

Auth: `X-Admin-Key: <value>`

Creates a new tenant and generates an API key.

Request:
```json
{ "id": "skillpassport", "name": "Skill Passport" }
```

`id` is lowercased and non-alphanumeric characters replaced with `-`.

Response `201`:
```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "api_key": "sk_2f84c0f8...",
  "created_at": "2026-03-16T08:00:00.000Z"
}
```

The `api_key` is returned once only and never stored in plain text. Save it immediately.

---

### GET /admin/tenant?id=xxx

Auth: `X-Admin-Key: <value>`

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "config": {
    "name": "Skill Passport",
    "created_at": "2026-03-16T08:00:00.000Z"
  }
}
```

---

### GET /admin/tenants

Auth: `X-Admin-Key: <value>`

```json
{
  "success": true,
  "tenants": [
    {
      "tenant_id": "skillpassport",
      "name": "Skill Passport",
      "created_at": "2026-03-16T08:00:00.000Z"
    }
  ],
  "total": 1
}
```

---

### DELETE /admin/tenant?id=xxx

Auth: `X-Admin-Key: <value>`

```json
{ "success": true, "message": "Tenant 'skillpassport' deleted" }
```

Deleting a tenant does not delete its associated API key records from KV. Those keys will fail auth naturally since the tenant record no longer exists.

---

## Error Reference

All errors follow this shape:
```json
{
  "success": false,
  "errorCode": "UNAUTHORIZED",
  "message": "Invalid API key",
  "request_id": "req_abc123_def456"
}
```

| errorCode | HTTP | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid Bearer token or admin key |
| `INVALID_INPUT` | 400 | Validation failure — see message for details |
| `PROVIDER_ERROR` | 502 | Voyage AI returned an error after retry |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `NOT_FOUND` | 404 | Route not found |
| `TENANT_EXISTS` | 409 | Tenant ID already taken |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method on admin route |

---

## Local Development

**1. Install dependencies**
```bash
npm install
```

**2. Create `.dev.vars`**
```
ADMIN_KEY=local-admin-key
VOYAGE_API_KEY=pa-...
ENVIRONMENT=local
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8788,http://127.0.0.1:5173,http://127.0.0.1:8788
```

**3. Start dev server**
```bash
npm run dev
# runs on http://127.0.0.1:9004
```

**4. Create a tenant**
```bash
curl -X POST http://127.0.0.1:9004/admin/tenant \
  -H "X-Admin-Key: local-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"id":"test","name":"Test Tenant"}'
```

**5. Test endpoints**
```bash
# Text
curl -X POST http://127.0.0.1:9004/embeddings/text \
  -H "Authorization: Bearer sk_<key>" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world"}'

# Image (URL)
curl -X POST http://127.0.0.1:9004/embeddings/image \
  -H "Authorization: Bearer sk_<key>" \
  -H "Content-Type: application/json" \
  -d '{"input":{"type":"url","data":"https://example.com/image.jpg"}}'

# Doc (PDF)
curl -X POST http://127.0.0.1:9004/embeddings/doc \
  -H "Authorization: Bearer sk_<key>" \
  -H "Content-Type: application/json" \
  -d '{"input":{"mimeType":"application/pdf","data":"<base64>","filename":"doc.pdf"}}'
```

---

## Deployment

**1. Create KV namespaces**
```bash
npx wrangler kv namespace create EMBEDDING_KV --env development
npx wrangler kv namespace create EMBEDDING_KV --env staging
npx wrangler kv namespace create EMBEDDING_KV --env production
```

Replace the `REPLACE_WITH_*_KV_ID` placeholders in `wrangler.toml` with the returned IDs.

**2. Set secrets**
```bash
wrangler secret put ADMIN_KEY          --env production
wrangler secret put VOYAGE_API_KEY     --env production
```

**3. Deploy**
```bash
npx wrangler deploy --env production
```

Available deploy commands:
```bash
npm run deploy:dev        # → embedding-worker-dev
npm run deploy:staging    # → embedding-worker-staging
npm run deploy:production # → embedding-worker-production
```

---

## Swapping Providers

All provider logic is isolated in `providers.ts`. To switch from Voyage AI to another provider (e.g. Google Gemini):

1. Update the `VOYAGE` config — name, `textEndpoint`, `imageEndpoint`, models, pricing
2. Update the fetch body shape in `callTextProvider` and `callImageProvider` to match the new provider's API
3. Update `VOYAGE_API_KEY` → new key name in `types.ts` (`Env` interface) and `wrangler.toml`
4. Run `wrangler secret put <NEW_KEY_NAME>`

No changes needed in any handler files.
