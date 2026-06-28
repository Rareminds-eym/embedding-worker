# Embedding Worker

Multi-tenant embedding API on Cloudflare Workers. Converts text, images, and documents into vector embeddings using Google Gemini.

---

## Architecture

```text
Client Request
  POST /embeddings/text | /embeddings/image | /embeddings/doc
  Authorization: Bearer sk_<48hex>
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│  embedding-worker (Cloudflare Worker)                      │
│                                                            │
│  index.ts                                                  │
│  ├── OPTIONS → 204 (CORS preflight)                        │
│  ├── GET /health → public                                  │
│  ├── /admin/* → authenticateAdmin (X-Admin-Key)            │
│  │   └── admin.ts (tenant CRUD)                            │
│  └── /embeddings/* → authenticate (Bearer token)           │
│      └── handlers/ (text.ts, image.ts, doc.ts)             │
└────────┬───────────────────────────┬─────────────────────────┘
         │                           │
         ▼                           ▼
  EMBEDDING_KV              Google Gemini API
  tenant:<id>               gemini-embedding-2-preview
  api_keys:<hash>           - text → embedContent
  tenant_keys:...           - image → embedContent
  rl:...                    - pdf → embedContent (native)
                            - docx/xlsx → AI.toMarkdown → batchEmbedContents
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| KV Store | Cloudflare KV |
| Embeddings | Google Gemini `gemini-embedding-2-preview` |
| Doc Conversion | Cloudflare Workers AI `toMarkdown` |
| Local dev port | `9004` |

---

## File Structure

```text
src/
├── index.ts           — router, CORS, body size guards
├── types.ts           — interfaces, error classes
├── constants.ts       — limits, timeouts, rate limits
├── providers.ts       — Gemini API calls with retry logic
├── auth.ts            — Bearer token + admin key auth
├── admin.ts           — /admin/* handlers
├── handlers/
│   ├── text.ts        — POST /embeddings/text
│   ├── image.ts       — POST /embeddings/image
│   └── doc.ts         — POST /embeddings/doc
└── utils/
    ├── hash.ts        — sha256 via Web Crypto
    ├── ratelimit.ts   — KV-based rate limiter
    └── response.ts    — jsonOk, jsonError, CORS headers
```

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `ADMIN_KEY` | Secret | Protects `/admin/*` routes (min 32 chars) |
| `GEMINI_API_KEY` | Secret | Google Gemini API key |
| `ALLOWED_ORIGINS` | `wrangler.toml` vars | Comma-separated CORS allowlist |

Secrets: `.dev.vars` locally, `wrangler secret put` for deployed environments.

---

## KV Data Model

Namespace: `EMBEDDING_KV`

```text
tenant:<id>                        →  { name, created_at }
api_keys:<sha256(token)>           →  { tenant_id, created_at }
tenant_keys:<tenantId>:<sha256>    →  "1" (reverse index for deletion)
rl:<tenantId>:<endpoint>:<window>  →  count (TTL 120s)
```

Raw API tokens are never stored — only SHA-256 hashes.

---

## Auth Flow

**Tenant auth:**

```text
Authorization: Bearer sk_<48hex>
  → validate format: /^sk_[a-f0-9]{48}$/
  → sha256(token)
  → KV get api_keys:<hash> → { tenant_id }
  → KV get tenant:<id> → TenantConfig
  → RequestContext { tenantId, requestId, startTime }
```

**Admin auth:**

```text
X-Admin-Key: <value>
  → sha256(provided) vs sha256(env.ADMIN_KEY)
  → timing-safe comparison via crypto.subtle.timingSafeEqual
```

---

## Rate Limiting

Per-tenant per-endpoint, KV fixed window counter.

| Endpoint | Limit |
|---|---|
| `/embeddings/text` | 120 req/min |
| `/embeddings/image` | 60 req/min |
| `/embeddings/doc` | 30 req/min |

KV is eventually consistent — concurrent bursts can exceed limits. Use Durable Objects for strict enforcement.

---

## CORS

Origins configured per environment in `wrangler.toml` via `ALLOWED_ORIGINS`.

| Environment | Allowed Origins |
|---|---|
| local | `http://localhost:5173`, `http://127.0.0.1:5173` |
| dev | `https://dev.skillpassports.com` |
| staging | `https://stag.skillpassports.com` |
| production | `https://skillpassport.com`, `https://www.skillpassports.com` |

---

## Limits

```typescript
// Text
TEXT_MAX_CHARS           = 120_000
MAX_REQUEST_BODY_SIZE    = 1_000_000

// Image
MAX_IMAGE_BATCH_SIZE          = 6
MAX_IMAGE_REQUEST_BODY_SIZE   = 20_000_000
// Only image/jpeg and image/png supported

// Doc
MAX_DOC_REQUEST_BODY_SIZE     = 10_000_000
MAX_DOC_BINARY_SIZE           = 2_000_000
DOC_CHUNK_SIZE                = 8_000
DOC_CHUNK_OVERLAP             = 400
DOC_MAX_CHUNKS                = 50
DOC_MAX_PAGES                 = 100
// PDF: max 6 pages per Gemini call

// Provider
RETRY_DELAY_MS            = 1_000
MAX_RETRIES               = 3
DOC_BATCH_SIZE            = 10
MAX_DOC_BATCH_CONCURRENCY = 4
```

---

## Model

All endpoints use `gemini-embedding-2-preview`

| Property | Value |
|---|---|
| Model | `gemini-embedding-2-preview` |
| Dimensions | 3072 (normalized) |
| Modalities | Text, image (PNG/JPEG), PDF |
| Max text tokens | 8,192 |
| Max images per call | 6 |
| Max PDF pages per call | 6 |

---

## Input Guide

### Text Endpoint

Accepts string, object, or array.

```json
{ "input": "Software engineer with 5 years React experience" }
```

```json
{
  "input": {
    "title": "Senior Backend Engineer",
    "skills": ["Rust", "Go", "PostgreSQL"]
  }
}
```

```json
{
  "input": ["Python developer", { "skill": "FastAPI", "years": 3 }, "REST API design"]
}
```

Arrays are joined into a single embedding.

#### task_type (optional)

Defaults to `RETRIEVAL_DOCUMENT`.

```json
{ "input": "find me a frontend engineer", "task_type": "RETRIEVAL_QUERY" }
```

| task_type | Use when |
|---|---|
| `RETRIEVAL_DOCUMENT` | Indexing content (default) |
| `RETRIEVAL_QUERY` | Embedding search queries |
| `SEMANTIC_SIMILARITY` | Comparing text |
| `CLASSIFICATION` | Categorizing text |
| `CLUSTERING` | Grouping similar content |
| `QUESTION_ANSWERING` | QA retrieval |
| `FACT_VERIFICATION` | Fact-checking |
| `CODE_RETRIEVAL_QUERY` | Code search |

---

### Image Endpoint

Only `image/jpeg` and `image/png` supported. Single or batch up to 6.

```json
{ "input": { "type": "url", "data": "https://example.com/photo.jpg" } }
```

```json
{ "input": { "type": "base64", "mediaType": "image/jpeg", "data": "/9j/4AAQ..." } }
```

URL inputs are fetched server-side (SSRF protection blocks private IPs).

---

### Doc Endpoint

Documents must be base64-encoded.

```json
{
  "input": {
    "mimeType": "application/pdf",
    "data": "<base64>",
    "filename": "resume.pdf"
  },
  "max_pages": 6
}
```

| File | mimeType |
|---|---|
| PDF | `application/pdf` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |

PDFs return a single embedding. DOCX/XLSX return one embedding per chunk.

---

## API Reference

### GET /health

```json
{ "status": "ok", "version": "1.0.0", "timestamp": "2026-03-24T08:00:00.000Z" }
```

---

### POST /embeddings/text

```json
{
  "success": true,
  "embedding": [0.023, -0.041, 0.017, ...],
  "model": "gemini-embedding-2-preview",
  "dimensions": 3072,
  "task_type": "RETRIEVAL_DOCUMENT",
  "request_id": "a1b2c3d4-...",
  "latency_ms": 210
}
```

---

### POST /embeddings/image

Single:

```json
{
  "success": true,
  "embeddings": [{
    "index": 0,
    "embedding": [0.013, -0.057, ...],
    "dimensions": 3072
  }],
  "model": "gemini-embedding-2-preview",
  "request_id": "a1b2c3d4-...",
  "latency_ms": 691
}
```

---

### POST /embeddings/doc

PDF:

```json
{
  "success": true,
  "embeddings": [{
    "index": 0,
    "embedding": [...],
    "dimensions": 3072
  }],
  "model": "gemini-embedding-2-preview",
  "document": {
    "filename": "resume.pdf",
    "mimeType": "application/pdf",
    "type": "PDF",
    "chunks": 1
  },
  "usage": { "estimated_tokens": 3072 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 1200
}
```

DOCX/XLSX:

```json
{
  "success": true,
  "embeddings": [
    { "index": 0, "embedding": [...], "dimensions": 3072 },
    { "index": 1, "embedding": [...], "dimensions": 3072 }
  ],
  "model": "gemini-embedding-2-preview",
  "document": {
    "filename": "report.docx",
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "type": "Word",
    "total_chars": 18531,
    "chunks": 2,
    "chunk_size": 8000,
    "chunk_overlap": 400
  },
  "usage": { "estimated_tokens": 5295 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 3200
}
```

---

### POST /admin/tenant

```json
{ "id": "skillpassport", "name": "Skill Passport" }
```

Response `201`:

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "api_key": "sk_2f84c0f8...",
  "warning": "Save this API key now. It will not be shown again.",
  "created_at": "2026-03-24T08:00:00.000Z"
}
```

---

### GET /admin/tenant?id=xxx

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "config": { "name": "Skill Passport", "created_at": "2026-03-24T08:00:00.000Z" }
}
```

---

### GET /admin/tenants?limit=50&cursor=xxx

```json
{
  "success": true,
  "tenants": [{ "tenant_id": "skillpassport", "name": "Skill Passport", "created_at": "..." }],
  "count": 1,
  "next_cursor": "optional-cursor-string"
}
```

---

### DELETE /admin/tenant?id=xxx

```json
{ "success": true, "message": "Tenant 'skillpassport' deleted" }
```

---

## Error Reference

```json
{ "success": false, "errorCode": "UNAUTHORIZED", "message": "Invalid API key", "request_id": "..." }
```

| errorCode | HTTP | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid Bearer token or admin key |
| `INVALID_INPUT` | 400 | Validation failure |
| `RATE_LIMIT_EXCEEDED` | 429 | Per-tenant rate limit hit |
| `PROVIDER_ERROR` | 502 | Gemini API error after retries |
| `INTERNAL_ERROR` | 500/503/504 | Server error, missing secret, or timeout |
| `NOT_FOUND` | 404 | Route or resource not found |
| `TENANT_EXISTS` | 409 | Tenant ID already taken |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |

---

## Local Development

```bash
npm install
npm run kv:create:local   # update wrangler.toml with returned ID
```

`.dev.vars`:

```ini
ADMIN_KEY=local-admin-key-32chars-minimum
GEMINI_API_KEY=AIza...
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

```bash
npm run dev    # http://127.0.0.1:9004
npm run test
```

---

## Deployment

```bash
# Create KV namespaces
npm run kv:create:dev
npm run kv:create:staging
npm run kv:create:production

# Set secrets
wrangler secret put ADMIN_KEY      --env production
wrangler secret put GEMINI_API_KEY --env production

# Deploy
npm run deploy:production
```

---

## Swapping Providers

All provider logic is in `providers.ts`. To switch:

1. `providers.ts` — update endpoints, model ID, dimensions, request/response shapes
2. `types.ts` — rename `GEMINI_API_KEY` in `Env` interface
3. `wrangler.toml` — update secret name
4. `wrangler secret put <NEW_KEY_NAME>`

Note: Image handler fetches URLs server-side because Gemini requires `inline_data`. If the new provider accepts URLs directly, remove that fetch logic. PDF native path in `doc.ts` is Gemini-specific — other providers would need the `AI.toMarkdown` → chunks path for PDFs.
