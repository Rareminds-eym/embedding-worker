# Embedding Worker

A multi-tenant embedding API built on Cloudflare Workers. Converts text, images, and documents into vector embeddings using Google's Gemini multimodal embedding model. Designed for the SkillPassports platform.

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
┌──────────────────┐         ┌─────────────────────────────────────┐
│  EMBEDDING_KV    │         │  providers.ts                       │
│                  │         │                                     │
│  tenant:<id>     │         │  Google Gemini API                  │
│  api_keys:<hash> │         │  model: gemini-embedding-2-preview  │
│  tenant_keys:... │         │                                     │
│  rl:...          │         │  text  → batchEmbedContents         │
└──────────────────┘         │  image → embedContent (per image)   │
                             │  pdf   → embedContent (native)      │
                             │  docx/xlsx → AI.toMarkdown          │
                             │              → batchEmbedContents   │
                             └─────────────────────────────────────┘
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| KV Store | Cloudflare KV (`EMBEDDING_KV`) |
| All Embeddings | Google Gemini — `gemini-embedding-2-preview` |
| DOCX/XLSX → Markdown | Cloudflare Workers AI `toMarkdown` |
| Local dev port | `9004` |

---

## File Structure

```text
src/
├── index.ts           — entry point, router, CORS, per-route body size guard
├── types.ts           — Env, interfaces, error classes
├── constants.ts       — all limits, timeouts, rate limits, error codes
├── providers.ts       — provider config, model config, HTTP callers with retry
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

All provider HTTP logic lives exclusively in `providers.ts`. Handlers never touch endpoints, auth headers, or request shapes directly. To swap providers, only `providers.ts`, `types.ts` (API key name), and `wrangler.toml` need to change.

```text
handlers/text.ts  ──→  callTextProvider()        ──→  Gemini batchEmbedContents
handlers/doc.ts   ──→  callDocProvider()         ──→  Gemini batchEmbedContents (batched chunks)
                  ──→  callPdfProvider()         ──→  Gemini embedContent (native PDF)
handlers/image.ts ──→  callImageBatchProvider()  ──→  Gemini embedContent (per image, concurrent)
```

**PDF path:** PDFs are sent directly to Gemini as `inline_data` with `application/pdf`. Gemini processes the visual and text content of each page natively — no text extraction step. Maximum 6 pages per call.

**DOCX/XLSX path:** Converted to markdown via `env.AI.toMarkdown`, then chunked and embedded via `batchEmbedContents`.

**Image path:** Gemini requires `inline_data` (no URL support). URL inputs are fetched by the worker, converted to base64, then sent to Gemini. Only `image/png` and `image/jpeg` are supported by the model.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `ADMIN_KEY` | Secret | Protects all `/admin/*` routes |
| `GEMINI_API_KEY` | Secret | Google Gemini API key — required for all embedding endpoints |
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

**Important:** KV is eventually consistent — the counter is not atomic. Concurrent bursts can exceed limits by the degree of concurrency. This is a soft quota guard, not a hard security boundary. Use Durable Objects if strict enforcement is required.

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
// Gemini only accepts image/jpeg and image/png — other types rejected at validation

// Doc
MAX_DOC_REQUEST_BODY_SIZE     = 10_000_000   // 10MB (JSON body)
MAX_DOC_BINARY_SIZE           = 2_000_000    // 2MB decoded binary
DOC_CHUNK_SIZE                = 8_000        // chars per chunk (DOCX/XLSX only)
DOC_CHUNK_OVERLAP             = 400          // overlap between chunks
DOC_MAX_CHUNKS                = 50           // max chunks per document
DOC_MAX_PAGES                 = 100          // hard cap on max_pages param
// PDF: max 6 pages per Gemini call (native multimodal path)
// DOCX/XLSX: max processable chars = 50 * 2000 = 100_000

// Provider
RETRY_DELAY_MS            = 1_000
MAX_RETRIES               = 3     // retries on 5xx and 429 (with Retry-After delay)
DOC_BATCH_SIZE            = 10    // chunks per Gemini batch call
MAX_DOC_BATCH_CONCURRENCY = 4     // concurrent batch requests
```

---

## Model

All endpoints use a single model: `gemini-embedding-2-preview`

| Property | Value |
|---|---|
| Model | `gemini-embedding-2-preview` |
| Dimensions | 3072 (default, normalized) |
| Modalities | Text, image (PNG/JPEG), PDF, audio, video |
| Max text tokens | 8,192 |
| Max images per call | 6 |
| Max PDF pages per call | 6 |

All modalities share the same vector space — text, image, and PDF embeddings are directly comparable via cosine similarity.

---

## Input Guide

### Text Endpoint

The `input` field accepts a plain string, an object, or an array.

```json
{ "input": "Software engineer with 5 years React experience" }
```

```json
{
  "input": {
    "title": "Senior Backend Engineer",
    "skills": ["Rust", "Go", "PostgreSQL"],
    "location": "Berlin"
  }
}
```

**Fields automatically skipped:** keys containing `id`, timestamp fields (`created_at`, `updatedAt`, etc.), `embedding`, boolean `false` values.

#### task_type (optional)

Controls how Gemini optimizes the embedding. Defaults to `RETRIEVAL_DOCUMENT`.

```json
{ "input": "find me a frontend engineer", "task_type": "RETRIEVAL_QUERY" }
```

| task_type | Use when |
|---|---|
| `RETRIEVAL_DOCUMENT` | Indexing content into a vector DB (default) |
| `RETRIEVAL_QUERY` | Embedding a search query against indexed content |
| `SEMANTIC_SIMILARITY` | Comparing two pieces of text |
| `CLASSIFICATION` | Categorizing text |
| `CLUSTERING` | Grouping similar content |
| `QUESTION_ANSWERING` | Embedding questions for QA retrieval |
| `FACT_VERIFICATION` | Embedding statements for fact-checking |
| `CODE_RETRIEVAL_QUERY` | Searching code with natural language |

**Use matching task types.** Index with `RETRIEVAL_DOCUMENT`, query with `RETRIEVAL_QUERY`. Mixing them degrades retrieval quality.

---

### Image Endpoint

Only `image/jpeg` and `image/png` are supported. Single image or batch up to 5.

```json
{ "input": { "type": "url", "data": "https://example.com/photo.jpg" } }
```

```json
{ "input": { "type": "base64", "mediaType": "image/jpeg", "data": "/9j/4AAQ..." } }
```

URL inputs are fetched server-side (SSRF protection blocks private IPs). `data` is raw base64 — no `data:image/...;base64,` prefix.

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

PDFs return a single embedding (Gemini native path). DOCX/XLSX return one embedding per chunk.

---

## API Reference

### GET /health

```json
{ "status": "ok", "version": "1.0.0", "timestamp": "2026-03-17T08:00:00.000Z" }
```

---

### POST /embeddings/text

Response:

```json
{
  "success": true,
  "embedding": [0.023, -0.041, 0.017],
  "model": "gemini-embedding-2-preview",
  "dimensions": 3072,
  "task_type": "RETRIEVAL_DOCUMENT",
  "usage": { "estimated_cost_usd": 0 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 210
}
```

---

### POST /embeddings/image

Single response:

```json
{
  "success": true,
  "embedding": [0.013, -0.057, 0.009],
  "dimensions": 3072,
  "model": "gemini-embedding-2-preview",
  "usage": { "estimated_cost_usd": 0 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 691
}
```

Batch response returns `embeddings: [{ index, embedding, dimensions }]` instead of `embedding`.

---

### POST /embeddings/doc

PDF response:

```json
{
  "success": true,
  "embeddings": [{ "index": 0, "embedding": [...], "dimensions": 3072 }],
  "model": "gemini-embedding-2-preview",
  "document": { "filename": "resume.pdf", "mimeType": "application/pdf", "type": "PDF", "max_pages": 6, "chunks": 1 },
  "usage": { "total_tokens": 4608, "estimated_cost_usd": 0 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 1200
}
```

DOCX/XLSX response:

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
  "usage": { "total_tokens": 4632, "estimated_cost_usd": 0 },
  "request_id": "a1b2c3d4-...",
  "latency_ms": 3200
}
```

---

### POST /admin/tenant

```json
{ "id": "skillpassport", "name": "Skill Passport" }
```

Response `201` — `api_key` shown once only, never stored in plain text:

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "api_key": "sk_2f84c0f8...",
  "created_at": "2026-03-17T08:00:00.000Z"
}
```

---

### GET /admin/tenant?id=xxx

```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "config": { "name": "Skill Passport", "created_at": "2026-03-17T08:00:00.000Z" }
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
| `INVALID_INPUT` | 400 | Validation failure — see `message` |
| `RATE_LIMIT_EXCEEDED` | 429 | Per-tenant rate limit hit — check `Retry-After` header |
| `PROVIDER_ERROR` | 502 | Gemini API returned an error after retries |
| `INTERNAL_ERROR` | 500/503/504 | Server error, missing secret, or conversion timeout |
| `NOT_FOUND` | 404 | Route or resource not found |
| `TENANT_EXISTS` | 409 | Tenant ID already taken |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method on admin route |

---

## Local Development

```bash
npm install
npm run kv:create:local   # replace REPLACE_WITH_LOCAL_KV_ID in wrangler.toml with returned ID
```

`.dev.vars`:

```ini
ADMIN_KEY=local-admin-key
GEMINI_API_KEY=AIza...
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8788,http://127.0.0.1:5173,http://127.0.0.1:8788
```

```bash
npm run dev    # http://127.0.0.1:9004
npm run test
```

---

## Deployment

```bash
# Create KV namespaces and update wrangler.toml with returned IDs
npm run kv:create:dev
npm run kv:create:staging
npm run kv:create:production

# Set secrets per environment
wrangler secret put ADMIN_KEY      --env production
wrangler secret put GEMINI_API_KEY --env production

# Deploy
npm run deploy:production
```

---

## Swapping Providers

All provider logic is in `providers.ts`. To switch:

1. `providers.ts` — update endpoint URLs, model ID, dimensions, request/response shapes
2. `types.ts` — rename `GEMINI_API_KEY` in the `Env` interface
3. `wrangler.toml` — update secret name comments
4. `wrangler secret put <NEW_KEY_NAME>`

Note: the image handler fetches URLs server-side because Gemini requires `inline_data`. If the new provider accepts URLs directly, that fetch logic in `handlers/image.ts` can be removed. The PDF native path in `handlers/doc.ts` is also Gemini-specific — other providers would need the `AI.toMarkdown` → chunks path for PDFs.
