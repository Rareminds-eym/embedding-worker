# Embedding Worker

A multi-tenant embedding API built on Cloudflare Workers. Converts text, images, and documents into vector embeddings. Designed for the SkillPassports platform.

---

## Architecture

```text
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
│  ├── Content-Length guard (per-route limits)                    │
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
│                                        ├── text.ts              │
│                                        ├── image.ts             │
│                                        └── doc.ts               │
└──────────┬───────────────────────────────┬──────────────────────┘
           │                               │
           ▼                               ▼
┌──────────────────┐         ┌─────────────────────────────────┐
│  EMBEDDING_KV    │         │  providers.ts                   │
│                  │         │                                 │
│  tenant:<id>     │         │  OpenAI via OpenRouter          │
│  api_keys:<hash> │         │  ├── /v1/embeddings             │
│  tenant_keys:... │         │      used by: text, doc         │
│  rl:...          │         │                                 │
└──────────────────┘         │  Voyage AI                      │
                             │  └── /v1/multimodalembeddings   │
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
| Text & Doc Embeddings | OpenAI `text-embedding-3-small` via OpenRouter |
| Image Embeddings | Voyage AI — `voyage-multimodal-3.5` (default) |
| Doc → Markdown | Cloudflare Workers AI `toMarkdown` |
| Local dev port | `9004` |

---

## File Structure

```text
src/
├── index.ts           — entry point, router, CORS, per-route body size guard
├── types.ts           — Env, interfaces, error classes
├── constants.ts       — all limits, timeouts, rate limits, error codes
├── providers.ts       — provider config, model resolvers, HTTP callers with retry
├── auth.ts            — Bearer token auth + admin key auth (timing-safe)
├── admin.ts           — /admin/* route handlers
├── handlers/
│   ├── text.ts        — POST /embeddings/text
│   ├── image.ts       — POST /embeddings/image
│   └── doc.ts         — POST /embeddings/doc
└── utils/
    ├── hash.ts        — sha256 via Web Crypto API
    ├── ratelimit.ts   — KV-based fixed window rate limiter (per-tenant)
    └── response.ts    — jsonOk, jsonError, handleError, getCorsHeaders
```

---

## Provider Design

All provider HTTP logic lives exclusively in `providers.ts`. Handlers never touch endpoints, auth headers, or request shapes directly.

```text
handlers/text.ts  ──→  callTextProvider()  ──→  OpenRouter /v1/embeddings
handlers/doc.ts   ──→  callDocProvider()   ──→  OpenRouter /v1/embeddings  (batched)
handlers/image.ts ──→  callImageProvider() ──→  VOYAGE.imageEndpoint
```

- Text and doc always use OpenAI `text-embedding-3-small` via OpenRouter. There is no fallback or model selection on these endpoints.
- Image always uses Voyage AI. Model can be overridden via the `model` request field.
- To swap providers, only edit `providers.ts` — no handler files need to change.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `ADMIN_KEY` | Secret | Protects all `/admin/*` routes |
| `VOYAGE_API_KEY` | Secret | Voyage AI API key — required for `/embeddings/image` |
| `OPENAI_API_KEY` | Secret | OpenAI via OpenRouter — required for `/embeddings/text` and `/embeddings/doc` |
| `ALLOWED_ORIGINS` | `wrangler.toml` vars | Comma-separated CORS allowlist |
| `ENVIRONMENT` | `wrangler.toml` vars | `local` / `dev` / `staging` / `production` |

Secrets are set via `.dev.vars` locally and `wrangler secret put` for deployed environments.

---

## KV Data Model

Namespace: `EMBEDDING_KV`

```text
tenant:<id>                        →  { name: string, created_at: string }
api_keys:<sha256(token)>           →  { tenant_id: string, created_at: string }
tenant_keys:<tenantId>:<sha256>    →  "1"   (reverse index — enables O(n_keys) tenant deletion)
lock:tenant:<id>                   →  "1"   (TTL 60s — creation lock, best-effort)
rl:<tenantId>:<endpoint>:<window>  →  count (TTL 120s — rate limit counter)
```

- Raw API tokens are never stored — only their SHA-256 hash.
- Deleting a tenant revokes all its API keys via the `tenant_keys:` reverse index.
- Rate limit keys expire automatically — no cleanup needed on normal operation.

---

## Auth Flow

**Tenant auth (embedding routes):**

```text
Authorization: Bearer sk_<48 lowercase hex chars>
  → validate format: /^sk_[a-f0-9]{48}$/
  → sha256(token)
  → KV get api_keys:<hash>  → { tenant_id }
  → KV get tenant:<id>      → TenantConfig (confirms tenant not deleted)
  → RequestContext { tenantId, requestId, startTime }
```

**Admin auth:**

```text
X-Admin-Key: <value>
  → sha256(provided key) vs sha256(env.ADMIN_KEY)
  → timing-safe comparison via crypto.subtle.timingSafeEqual
  → rejects immediately if either side is empty
```

---

## Rate Limiting

Rate limits are enforced per-tenant per-endpoint using a KV fixed window counter. The counter is incremented only after all input validation passes — malformed requests do not consume quota.

| Endpoint | Limit |
|---|---|
| `/embeddings/text` | 120 req/min |
| `/embeddings/image` | 60 req/min |
| `/embeddings/doc` | 30 req/min |

**Important:** KV is eventually consistent — the counter is not atomic. Concurrent bursts can exceed limits by the degree of concurrency. KV also enforces a ~1 write/sec per-key limit, which the text endpoint (120 req/min) can exceed under sustained load. This is a soft quota guard, not a hard security boundary. Use Durable Objects if strict enforcement is required.

On limit exceeded, the response includes a `Retry-After` header and `retry_after_seconds` in the body.

---

## CORS

Origins are configured per environment in `wrangler.toml` via `ALLOWED_ORIGINS`. Only listed origins are reflected — no wildcard fallback.

| Environment | Allowed Origins |
|---|---|
| local | `http://localhost:5173`, `http://localhost:8788`, `http://127.0.0.1:5173`, `http://127.0.0.1:8788` |
| dev | `https://dev.skillpassports.com` |
| staging | `https://stag.skillpassports.com` |
| production | `https://skillpassport.com`, `https://www.skillpassports.com` |

---

## Limits & Constants

```typescript
// Text
TEXT_MAX_CHARS           = 120_000     // ~30K tokens
MAX_REQUEST_BODY_SIZE    = 1_000_000   // 1MB

// Image
MAX_IMAGE_BATCH_SIZE          = 5
MAX_IMAGE_REQUEST_BODY_SIZE   = 20_000_000   // 20MB
ALLOWED_IMAGE_MEDIA_TYPES     = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']

// Doc
MAX_DOC_REQUEST_BODY_SIZE     = 10_000_000   // 10MB (JSON body)
MAX_DOC_BINARY_SIZE           = 2_000_000    // 2MB decoded binary
DOC_CHUNK_SIZE                = 8_000        // chars per chunk
DOC_CHUNK_OVERLAP             = 400          // overlap between chunks
DOC_MAX_CHUNKS                = 50           // max chunks per document
DOC_MAX_PAGES                 = 100          // hard cap on max_pages param
DOC_MIN_CONTENT_CHARS         = 50           // min chars before image-only error
ALLOWED_DOC_TYPES             = PDF, Word (.docx), Excel (.xlsx)
// Max processable chars = DOC_MAX_CHUNKS * (DOC_CHUNK_SIZE / 4) = 50 * 2000 = 100_000

// Provider
VOYAGE_TIMEOUT_MS        = 30_000   // 30s per provider call
RETRY_DELAY_MS           = 1_000
MAX_RETRIES              = 3        // retries on 5xx and 429 (with Retry-After delay)
DOC_BATCH_SIZE           = 10       // chunks per OpenRouter batch in doc handler
MAX_DOC_BATCH_CONCURRENCY = 4       // concurrent batch requests in doc handler
```

---

## Models

### Text & Doc — OpenAI via OpenRouter

Text and doc endpoints always use `openai/text-embedding-3-small`. The `model` parameter is not accepted on these endpoints — passing it returns a 400.

| Model | Dimensions | Cost per 1M tokens |
|---|---|---|
| `text-embedding-3-small` | 1536 | $0.02 |

### Image — Voyage AI

| Model | Dimensions | Cost per 1M tokens |
|---|---|---|
| `voyage-multimodal-3.5` | 1024 | $0.12 (default) |
| `voyage-multimodal-3` | 1024 | $0.12 |

---

## Input Guide

---

### Text Endpoint Inputs

The `input` field accepts a plain string, an object, or an array. The API normalizes all non-string inputs automatically.

#### Plain string

```json
{ "input": "Software engineer with 5 years of experience in React and Node.js" }
```

#### Object

Pass any JSON object. The API recursively extracts all meaningful text values and joins them into a single string before embedding.

```json
{
  "input": {
    "name": "Jane Smith",
    "title": "Senior Backend Engineer",
    "bio": "Passionate about distributed systems and Rust.",
    "skills": ["Rust", "Go", "PostgreSQL", "Kubernetes"],
    "location": "Berlin, Germany"
  }
}
```

**Fields automatically skipped:**
- Keys containing `id` (e.g. `user_id`, `uuid`, `_id`, `jobId`)
- Timestamp fields: `created_at`, `updated_at`, `createdAt`, `updatedAt`, `deleted_at`, `deletedAt`
- Fields named `embedding`
- Boolean `false` values

**Nested objects and nested JSON strings** are fully supported and recursively extracted.

#### Array

All items are normalized and joined into one string for a single embedding call.

```json
{ "input": ["machine learning", "natural language processing", "vector databases"] }
```

Mixed arrays (strings and objects) also work:

```json
{
  "input": [
    "Python developer",
    { "skill": "FastAPI", "years": 3 },
    "REST API design"
  ]
}
```

---

### Image Endpoint Inputs

Each image input is an object with `type` and `data`. Pass a single image or a batch of up to 5.

#### Single image via URL

```json
{
  "input": { "type": "url", "data": "https://example.com/photo.jpg" }
}
```

#### Single image via base64

```json
{
  "input": {
    "type": "base64",
    "mediaType": "image/jpeg",
    "data": "/9j/4AAQSkZJRgABAQAA..."
  }
}
```

- `data` — raw base64 string, no `data:image/jpeg;base64,` prefix
- `mediaType` — one of: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/bmp`

#### Batch (up to 5 images)

```json
{
  "input": [
    { "type": "url", "data": "https://example.com/photo1.jpg" },
    { "type": "base64", "mediaType": "image/png", "data": "iVBORw0KGgo..." }
  ]
}
```

Batch response returns an `embeddings` array (indexed) instead of a single `embedding`.

#### Model selection

```json
{ "input": { "type": "url", "data": "..." }, "model": "voyage-multimodal-3" }
```

---

### Doc Endpoint Inputs

Documents must be base64-encoded. The API converts them to markdown internally, chunks the text, and returns one embedding per chunk.

#### Basic request

```json
{
  "input": {
    "mimeType": "application/pdf",
    "data": "<base64 encoded file>",
    "filename": "resume.pdf"
  }
}
```

- `mimeType` — required, must match the actual file type
- `data` — required, base64-encoded file content
- `filename` — optional, used for logging; defaults to `document.<ext>`

**Supported types:**

| File | mimeType |
|---|---|
| PDF | `application/pdf` |
| Word (.docx) | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Excel (.xlsx) | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |

#### With page limit

```json
{
  "input": { "mimeType": "application/pdf", "data": "<base64>", "filename": "report.pdf" },
  "max_pages": 5
}
```

- Integer, 1–100
- Page boundaries detected via form-feed characters (`\f`) in extracted text
- If no form-feeds exist, pages estimated at 3,000 chars/page
- Response includes `pages_detected` and `pages_processed` when set

#### How to base64-encode a file

**Node.js:**
```javascript
const fs = require('fs');
const base64 = fs.readFileSync('resume.pdf').toString('base64');
const body = { input: { mimeType: 'application/pdf', data: base64, filename: 'resume.pdf' } };
```

**Browser (File input):**
```javascript
async function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
const base64 = await encodeFile(fileInput.files[0]);
```

**Python:**
```python
import base64
with open('resume.pdf', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')
```

#### Understanding the chunked response

Large documents are split into overlapping chunks (8,000 chars, 400-char overlap). Each chunk gets its own embedding. Store each chunk separately in your vector DB with metadata linking back to the source document (`doc_id`, `chunk_index`, `filename`). At query time, search across all chunks and group by `doc_id`.

#### Image-only PDFs

`toMarkdown` extracts the text layer only. Scanned/image-only PDFs return a 400 directing you to `/embeddings/image` instead.

---

## API Reference

### GET /health

Public. No auth required.

```json
{ "status": "ok", "version": "1.0.0", "timestamp": "2026-03-17T08:00:00.000Z" }
```

---

### POST /embeddings/text

Auth: `Authorization: Bearer sk_<48hex>`

```json
{ "input": "plain string" }
{ "input": { "name": "Jane", "title": "Engineer", "skills": ["Python"] } }
{ "input": ["machine learning", "deep learning"] }
```

The `model` parameter is not supported. Text always uses `openai/text-embedding-3-small`.

Response:

```json
{
  "success": true,
  "embedding": [0.023, -0.041, 0.017],
  "model": "openai/text-embedding-3-small",
  "dimensions": 1536,
  "usage": { "total_tokens": 12, "estimated_cost_usd": 0.000001 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 210
}
```

---

### POST /embeddings/image

Auth: `Authorization: Bearer sk_<48hex>`

**Single image — URL:**
```json
{ "input": { "type": "url", "data": "https://example.com/image.jpg" } }
```

**Single image — base64:**
```json
{ "input": { "type": "base64", "data": "<raw base64>", "mediaType": "image/jpeg" } }
```

**Batch (up to 5):**
```json
{ "input": [ { "type": "url", "data": "..." }, { "type": "base64", "mediaType": "image/png", "data": "..." } ] }
```

Single response:

```json
{
  "success": true,
  "embedding": [0.013, -0.057, 0.009],
  "dimensions": 1024,
  "model": "voyage-multimodal-3.5",
  "usage": { "total_tokens": 89, "estimated_cost_usd": 0.000011 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 691
}
```

Batch response returns `embeddings` array instead of `embedding`.

---

### POST /embeddings/doc

Auth: `Authorization: Bearer sk_<48hex>`

The `model` parameter is not supported. Doc always uses `openai/text-embedding-3-small`.

```json
{
  "input": {
    "mimeType": "application/pdf",
    "data": "<base64>",
    "filename": "resume.pdf"
  },
  "max_pages": 10
}
```

Response:

```json
{
  "success": true,
  "embeddings": [
    { "index": 0, "embedding": [0.031, -0.012, 0.008], "dimensions": 1536 },
    { "index": 1, "embedding": [-0.004, 0.027, 0.019], "dimensions": 1536 }
  ],
  "model": "openai/text-embedding-3-small",
  "document": {
    "filename": "resume.pdf",
    "mimeType": "application/pdf",
    "type": "PDF",
    "total_chars": 18531,
    "chunks": 4,
    "chunk_size": 8000,
    "chunk_overlap": 400,
    "pages_detected": 7,
    "pages_processed": 5
  },
  "usage": { "total_tokens": 4303, "estimated_cost_usd": 0.000086 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 3200
}
```

`pages_detected` / `pages_processed` only appear when `max_pages` is set.

---

### POST /admin/tenant

Auth: `X-Admin-Key: <value>`

```json
{ "id": "skillpassport", "name": "Skill Passport" }
```

`id` must be lowercase alphanumeric with hyphens, 2–64 chars, cannot start or end with a hyphen.

Response `201`:

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "api_key": "sk_2f84c0f8...",
  "created_at": "2026-03-17T08:00:00.000Z"
}
```

The `api_key` is shown once only and never stored in plain text. Save it immediately.

---

### GET /admin/tenant?id=xxx

Auth: `X-Admin-Key: <value>`

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "config": { "name": "Skill Passport", "created_at": "2026-03-17T08:00:00.000Z" }
}
```

---

### GET /admin/tenants?limit=50&cursor=xxx

Auth: `X-Admin-Key: <value>`

```json
{
  "success": true,
  "tenants": [
    { "tenant_id": "skillpassport", "name": "Skill Passport", "created_at": "2026-03-17T08:00:00.000Z" }
  ],
  "count": 1,
  "next_cursor": "optional-cursor-string"
}
```

`count` is the number of tenants in the current page. Use `next_cursor` with `?cursor=` to paginate. Max page size is 100.

---

### DELETE /admin/tenant?id=xxx

Auth: `X-Admin-Key: <value>`

Deletes the tenant and revokes all its API keys.

```json
{ "success": true, "message": "Tenant 'skillpassport' deleted" }
```

For deployments that predate the `tenant_keys:` reverse index, append `?legacy_cleanup=true` to also scan the full `api_keys:` namespace for orphaned keys. This is a one-time migration operation — it is O(total API keys) and will be logged as `admin.legacy_cleanup_triggered`.

---

## Error Reference

All errors follow this shape:

```json
{
  "success": false,
  "errorCode": "UNAUTHORIZED",
  "message": "Invalid API key",
  "request_id": "a1b2c3d4-..."
}
```

| errorCode | HTTP | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid Bearer token or admin key |
| `INVALID_INPUT` | 400 | Validation failure — see `message` for details |
| `RATE_LIMIT_EXCEEDED` | 429 | Per-tenant rate limit hit — check `Retry-After` header |
| `PROVIDER_ERROR` | 502 | Upstream provider returned an error after retries |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `INTERNAL_ERROR` | 503 | Required secret not configured |
| `INTERNAL_ERROR` | 504 | Document conversion timed out |
| `NOT_FOUND` | 404 | Route or resource not found |
| `TENANT_EXISTS` | 409 | Tenant ID already taken |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method on admin route |

Rate limit responses also include `retry_after_seconds` in the body and a `Retry-After` header.

---

## Local Development

**1. Install dependencies**
```bash
npm install
```

**2. Create a KV namespace**
```bash
npm run kv:create:local
```

Replace `REPLACE_WITH_LOCAL_KV_ID` in `wrangler.toml` with the returned ID (appears twice — `id` and `preview_id`).

**3. Create `.dev.vars`**

```ini
ADMIN_KEY=local-admin-key
VOYAGE_API_KEY=pa-...
OPENAI_API_KEY=sk-or-...
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8788,http://127.0.0.1:5173,http://127.0.0.1:8788
```

**4. Start dev server**
```bash
npm run dev
# runs on http://127.0.0.1:9004
```

**5. Run the test suite**
```bash
npm run test
```

**6. Create a tenant manually**
```bash
curl -X POST http://127.0.0.1:9004/admin/tenant \
  -H "X-Admin-Key: local-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"id":"test","name":"Test Tenant"}'
```

---

## Deployment

**1. Create KV namespaces**
```bash
npm run kv:create:dev
npm run kv:create:staging
npm run kv:create:production
```

Replace each `REPLACE_WITH_*_KV_ID` placeholder in `wrangler.toml` with the returned IDs.

**2. Set secrets**
```bash
wrangler secret put ADMIN_KEY        --env production
wrangler secret put VOYAGE_API_KEY   --env production
wrangler secret put OPENAI_API_KEY   --env production
```

**3. Deploy**
```bash
npm run deploy:dev        # → embedding-worker (dev env)
npm run deploy:staging    # → embedding-worker (staging env)
npm run deploy:production # → embedding-worker (production env)
```

Each deploy script runs against the environment specified.

---

## Swapping Providers

All provider logic is isolated in `providers.ts`. To switch from OpenAI/Voyage to another provider:

1. Update the provider config — endpoint, model IDs, dimensions, pricing
2. Update the fetch body/response shape in `callTextProvider`, `callDocProvider`, and `callImageProvider`
3. Rename the API key env var in `types.ts` (`Env` interface) and `wrangler.toml`
4. Run `wrangler secret put <NEW_KEY_NAME>`

No changes needed in any handler files.
