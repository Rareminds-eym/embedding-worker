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
│  tenant:<id>     │         │  Voyage AI                      │
│  api_keys:<hash> │         │  ├── /v1/embeddings             │
└──────────────────┘         │  │   used by: text, doc         │
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
| Text & Doc Embeddings | Voyage AI — `voyage-4` (default) |
| Image Embeddings | Voyage AI — `voyage-multimodal-3.5` (default) |
| Doc → Markdown | Cloudflare Workers AI `toMarkdown` |
| Local dev port | `9004` |

---

## File Structure

```
src/
├── index.ts           — entry point, router, CORS, per-route body size guard
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
handlers/doc.ts   ──→  callDocProvider()   ──→  VOYAGE.textEndpoint  (batched)
handlers/image.ts ──→  callImageProvider() ──→  VOYAGE.imageEndpoint
```

To swap providers, only edit `providers.ts` — no handler files need to change.

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `ADMIN_KEY` | Secret | Protects all `/admin/*` routes |
| `VOYAGE_API_KEY` | Secret | Voyage AI API key |
| `OPENAI_API_KEY` | Secret | OpenAI via OpenRouter — used as fallback for text and doc endpoints |
| `ALLOWED_ORIGINS` | `wrangler.toml` vars | Comma-separated CORS allowlist |
| `ENVIRONMENT` | `wrangler.toml` vars | `local` / `dev` / `staging` / `production` |

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

## Provider Fallback

The worker uses OpenAI (`text-embedding-3-small`) via OpenRouter as a fallback provider in the following scenarios:

**Text endpoint:**
- Fallback is triggered on `429` (rate limit) or any `ProviderError` from Voyage AI
- Only works if `OPENAI_API_KEY` is set in secrets
- When fallback is used, the response includes `"fallback_provider": "openai"` and dimensions will be `1536` instead of `1024`

**Doc endpoint:**
- Single-chunk documents: Same fallback behavior as text endpoint (Voyage primary, OpenAI on failure)
- Multi-chunk documents (>1 chunk): Routes directly to OpenAI to guarantee uniform embedding dimensions across all chunks. If `OPENAI_API_KEY` is not set, returns `503 Service Unavailable`
- When OpenAI is used (fallback or multi-chunk), the response includes `"fallback_provider": "openai"` and dimensions will be `1536` instead of `1024`

**Image endpoint:**
- No fallback available (OpenAI does not support image embeddings)
- Always uses Voyage AI

```json
{
  "success": true,
  "embedding": [...],
  "model": "openai/text-embedding-3-small",
  "fallback_provider": "openai",
  "dimensions": 1536,
  ...
}
```

---

## CORS

Origins are configured per environment in `wrangler.toml` via `ALLOWED_ORIGINS`. Only listed origins are reflected — no wildcard fallback.

| Environment | Allowed Origins |
|---|---|
| local | `http://localhost:5173`, `http://localhost:8788`, `http://127.0.0.1:5173`, `http://127.0.0.1:8788` |
| dev | `https://dev.skillpassports.com` |
| staging | `https://stag.skillpassports.com` |
| production | `https://skillpassport.com`, `https://www.skillpassport.com` |

---

## Limits & Constants

```typescript
// Text
TEXT_MAX_CHARS           = 120_000     // ~30K tokens — respects Voyage 32K context window
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

// Provider
VOYAGE_TIMEOUT_MS    = 30_000   // 30s per Voyage call
RETRY_DELAY_MS       = 1_000
MAX_RETRIES          = 3        // retries on 5xx; 429 retries with Retry-After delay
DOC_BATCH_SIZE       = 10       // chunks per sequential Voyage batch in doc handler
```

---

## Voyage AI Models

| Model | Used For | Dimensions | Cost per 1M tokens |
|---|---|---|---|
| `voyage-4` | text, doc (default) | 1024 | $0.06 |
| `voyage-4-lite` | text, doc (cheaper) | 1024 | $0.02 |
| `voyage-4-large` | text, doc (highest quality) | 1024 | $0.12 |
| `voyage-multimodal-3.5` | image (default) | 1024 | $0.12 |
| `voyage-multimodal-3` | image (legacy) | 1024 | $0.12 |

Text and doc endpoints only accept text models. Image endpoint only accepts image models. Passing a model from the wrong group returns a 400.

---

## Input Guide

This section covers every accepted input format for each endpoint with real-world examples. Read this before implementing.

---

### Text Endpoint Inputs

The `input` field accepts three shapes: a plain string, an object, or an array. The API sanitizes all non-string inputs automatically — you don't need to stringify anything yourself.

#### Plain string

The simplest case. Pass any text directly.

```json
{ "input": "Software engineer with 5 years of experience in React and Node.js" }
```

Use this for: search queries, short descriptions, sentences, paragraphs.

---

#### Object (most common for structured data)

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

What gets embedded: `name: Jane Smith title: Senior Backend Engineer bio: Passionate about distributed systems and Rust. skills: Rust, Go, PostgreSQL, Kubernetes location: Berlin, Germany`

**Fields that are automatically skipped:**
- Any key containing `id` (e.g. `user_id`, `tenant_id`, `uuid`, `_id`, `jobId`) — these are identifiers, not semantic content
- Timestamp fields: `created_at`, `updated_at`, `createdAt`, `updatedAt`, `deleted_at`, `deletedAt`
- Fields named `embedding` — avoids accidentally re-embedding an existing vector
- Boolean `false` values — only `true` booleans are included

```json
{
  "input": {
    "user_id": "abc-123",        ← skipped (contains 'id')
    "created_at": "2024-01-01",  ← skipped (timestamp)
    "embedding": [0.1, 0.2],     ← skipped (embedding field)
    "active": false,             ← skipped (false boolean)
    "name": "Bob",               ← included
    "role": "admin",             ← included
    "active": true               ← included as "active: true"
  }
}
```

**Nested objects** are fully supported:

```json
{
  "input": {
    "profile": {
      "name": "Alice",
      "headline": "Product Designer"
    },
    "company": {
      "name": "Acme Corp",
      "industry": "SaaS"
    },
    "tags": ["UX", "Figma", "Design Systems"]
  }
}
```

**Nested JSON strings** are automatically parsed:

```json
{
  "input": "{\"role\": \"engineer\", \"department\": \"platform\", \"level\": \"senior\"}"
}
```

The string is detected as JSON, parsed, and extracted — same result as passing the object directly.

---

#### Array

Pass an array of strings or objects. All items are normalized and joined into one string for a single embedding call.

```json
{
  "input": ["machine learning", "natural language processing", "vector databases"]
}
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

#### Model selection

```json
{ "input": "some text", "model": "voyage-4-lite" }
```

| Model | Dimensions | Cost | When to use |
|---|---|---|---|
| `voyage-4` | 1024 | $0.06/1M | default, best quality |
| `voyage-4-lite` | 1024 | $0.02/1M | high volume, cost-sensitive |
| `voyage-4-large` | 1024 | $0.12/1M | highest quality |
---

### Image Endpoint Inputs

Each image input is an object with `type` and `data`. You can pass a single image or a batch of up to 5.

#### Single image via URL

```json
{
  "input": {
    "type": "url",
    "data": "https://example.com/photo.jpg"
  }
}
```

The URL must be publicly accessible. The host must return a `Content-Length` header (required by Voyage AI).

---

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
- `mediaType` — must be one of: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/bmp`

**How to get base64 in JavaScript:**
```javascript
// From a File object (browser)
const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]); // strip the data URI prefix
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

// From a file path (Node.js)
const fs = require('fs');
const base64 = fs.readFileSync('image.jpg').toString('base64');
```

---

#### Batch (up to 5 images)

Pass an array. Items can mix URLs and base64.

```json
{
  "input": [
    { "type": "url", "data": "https://example.com/photo1.jpg" },
    { "type": "url", "data": "https://example.com/photo2.jpg" },
    { "type": "base64", "mediaType": "image/png", "data": "iVBORw0KGgo..." }
  ]
}
```

Batch response returns `embeddings` array (indexed) instead of a single `embedding`.

---

#### Image size limits

- Max 20MB per image (base64 or URL)
- Max ~4000×4000 pixels (16 million pixels)
- Token cost: every 560 pixels = 1 token

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

- `mimeType` — required, must match the actual file type (see table below)
- `data` — required, base64-encoded file content
- `filename` — optional, used for logging; defaults to `document.pdf` / `document.docx` / `document.xlsx`

**Supported types:**

| File | mimeType |
|---|---|
| PDF | `application/pdf` |
| Word (.docx) | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Excel (.xlsx) | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |

---

#### With page limit

Use `max_pages` to limit how many pages are processed. Useful for large documents where you only need the first N pages (e.g. a CV, executive summary, first chapter).

```json
{
  "input": {
    "mimeType": "application/pdf",
    "data": "<base64>",
    "filename": "report.pdf"
  },
  "max_pages": 5
}
```

- Integer, 1–100
- Page boundaries are detected via form-feed characters (`\f`) in the extracted text
- If no form-feeds exist, the API estimates pages at 3,000 chars/page
- Response includes `pages_detected` and `pages_processed` when this param is set

---

#### With model selection

```json
{
  "input": {
    "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "data": "<base64>",
    "filename": "job_description.docx"
  },
  "model": "voyage-4-lite"
}
```

---

#### How to base64-encode a file

**JavaScript (Node.js):**
```javascript
const fs = require('fs');

const fileBuffer = fs.readFileSync('resume.pdf');
const base64 = fileBuffer.toString('base64');

const body = {
  input: {
    mimeType: 'application/pdf',
    data: base64,
    filename: 'resume.pdf'
  }
};
```

**JavaScript (browser — File input):**
```javascript
async function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip data URI prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];
const base64 = await encodeFile(file);

const body = {
  input: {
    mimeType: file.type,
    data: base64,
    filename: file.name
  }
};
```

**Python:**
```python
import base64

with open('resume.pdf', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')

body = {
    'input': {
        'mimeType': 'application/pdf',
        'data': b64,
        'filename': 'resume.pdf'
    }
}
```

---

#### Understanding the chunked response

Large documents are split into overlapping chunks (8,000 chars each, 400-char overlap). Each chunk gets its own embedding. You get back an array:

```json
{
  "embeddings": [
    { "index": 0, "embedding": [...], "dimensions": 1024 },
    { "index": 1, "embedding": [...], "dimensions": 1024 },
    { "index": 2, "embedding": [...], "dimensions": 1024 }
  ]
}
```

When storing in a vector database, store each chunk embedding separately with metadata linking it back to the source document (e.g. `{ doc_id, chunk_index, filename }`). At query time, search across all chunks and group results by `doc_id`.

---

#### Image-only PDFs

`toMarkdown` extracts the text layer only. If a PDF has no text layer (scanned document, image-only), the API returns a 400 error:

```json
{
  "success": false,
  "errorCode": "INVALID_INPUT",
  "message": "Document produced no extractable text. This PDF appears to be image-only (scanned). Use /embeddings/image to embed individual page images instead."
}
```

For scanned PDFs, render each page as a JPEG/PNG image and send them to `/embeddings/image` instead.

---

## API Reference

### GET /health

Public. No auth required.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-03-17T08:00:00.000Z"
}
```

---

### POST /embeddings/text

Auth: `Authorization: Bearer sk_<48hex>`

Embeds a single text input. See [Input Guide — Text](#text-endpoint-inputs) for all accepted formats and sanitization rules.

```json
{ "input": "plain string" }
{ "input": { "name": "Jane", "title": "Engineer", "skills": ["Python"] } }
{ "input": ["machine learning", "deep learning"] }
{ "input": ["Python developer", { "skill": "FastAPI", "years": 3 }] }
{ "input": "...", "model": "voyage-4-lite" }
```

Response:
```json
{
  "success": true,
  "embedding": [0.023, -0.041, ...],
  "model": "voyage-4",
  "dimensions": 1024,
  "usage": {
    "total_tokens": 12,
    "estimated_cost_usd": "0.000001"
  },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "latency_ms": 210
}

---

### POST /embeddings/image

Auth: `Authorization: Bearer sk_<48hex>`

See [Input Guide — Image](#image-endpoint-inputs) for full details on URL vs base64 inputs and batch usage.

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

Single input response:
```json
{
  "success": true,
  "embedding": [0.013, -0.057, ...],
  "dimensions": 1024,
  "model": "voyage-multimodal-3.5",
  "usage": { "total_tokens": 89, "estimated_cost_usd": "0.000011" },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
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
  "usage": { "total_tokens": 536, "estimated_cost_usd": "0.000064" },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "latency_ms": 1200
}
```

Image limits (enforced by Voyage):
- Max 20MB per image
- Max 16 million pixels (~4000×4000)
- Supported formats: JPEG, PNG, WEBP, GIF, BMP
- Every 560 pixels = 1 token, max 32,000 tokens per input

---

### POST /embeddings/doc

Auth: `Authorization: Bearer sk_<48hex>`

See [Input Guide — Doc](#doc-endpoint-inputs) for base64 encoding examples, page limiting, and chunked response handling.

**Supported document types:**

| Type | mimeType |
|---|---|
| PDF | `application/pdf` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |

**Request:**
```json
{
  "input": {
    "mimeType": "application/pdf",
    "data": "<base64 encoded file>",
    "filename": "resume.pdf"
  },
  "model": "voyage-4-lite",
  "max_pages": 10
}
```

- `filename` — optional, defaults to `document.<ext>`
- `model` — optional, defaults to `voyage-4`
- `max_pages` — optional, integer 1–100

**Response:**
```json
{
  "success": true,
  "embeddings": [
    { "index": 0, "embedding": [...], "dimensions": 1024 },
    { "index": 1, "embedding": [...], "dimensions": 1024 }
  ],
  "model": "voyage-4",
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
  "usage": {
    "total_tokens": 4303,
    "estimated_cost_usd": "0.000258"
  },
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "latency_ms": 3200
}
```

`pages_detected` / `pages_processed` are only included when `max_pages` is set.

**Doc extraction notes:**
- `toMarkdown` extracts the text layer only — embedded images within PDFs are ignored
- PDFs with no text layer (scanned/image-only) return a 400 directing to `/embeddings/image`
- DOCX tables are preserved as markdown tables; complex PDF table layouts may lose structure but text is captured
- Excel sheets are converted to markdown tables per sheet
- Max binary size is 2MB — larger files should be split or use `max_pages`

---

### POST /admin/tenant

Auth: `X-Admin-Key: <value>`

Creates a new tenant and generates an API key.

```json
{ "id": "skillpassport", "name": "Skill Passport" }
```

`id` must match `/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/` — lowercase alphanumeric and hyphens only. Invalid IDs are rejected with a 400.

Response `201`:
```json
{
  "success": true,
  "tenant_id": "skillpassport",
  "api_key": "sk_2f84c0f8...",
  "created_at": "2026-03-17T08:00:00.000Z"
}
```

The `api_key` is returned once only and never stored in plain text.

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

### GET /admin/tenants

Auth: `X-Admin-Key: <value>`

```json
{
  "success": true,
  "tenants": [
    { "tenant_id": "skillpassport", "name": "Skill Passport", "created_at": "2026-03-17T08:00:00.000Z" }
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

---

## Error Reference

All errors follow this shape:
```json
{
  "success": false,
  "errorCode": "UNAUTHORIZED",
  "message": "Invalid API key",
  "request_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

| errorCode | HTTP | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid Bearer token or admin key |
| `INVALID_INPUT` | 400 | Validation failure — see message for details |
| `PROVIDER_ERROR` | 502 | Voyage AI returned an error after retry |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `INTERNAL_ERROR` | 504 | Document conversion timed out |
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
npm run kv:create:dev
npm run kv:create:staging
npm run kv:create:production
```

Replace the `REPLACE_WITH_*_KV_ID` placeholders in `wrangler.toml` with the returned IDs.

**2. Set secrets**
```bash
wrangler secret put ADMIN_KEY      --env production
wrangler secret put VOYAGE_API_KEY --env production
```

**3. Deploy**
```bash
npm run deploy:dev        # → embedding-worker (dev env)
npm run deploy:staging    # → embedding-worker (staging env)
npm run deploy:production # → embedding-worker (production env)
```

---

## Swapping Providers

All provider logic is isolated in `providers.ts`. To switch from Voyage AI to another provider:

1. Update the `VOYAGE` config — name, `textEndpoint`, `imageEndpoint`, models, pricing
2. Update the fetch body/response shape in `callTextProvider`, `callDocProvider`, and `callImageProvider`
3. Rename `VOYAGE_API_KEY` in `types.ts` (`Env` interface) and `wrangler.toml`
4. Run `wrangler secret put <NEW_KEY_NAME>`

No changes needed in any handler files.
