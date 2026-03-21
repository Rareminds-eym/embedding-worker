/**
 * Test script for the Embedding Worker
 *
 * Usage:
 *   1. Start the worker locally: npm run dev
 *   2. Run: npx tsx scripts/test-embed.ts
 *
 * Override defaults via env vars:
 *   API_URL=https://embedding-worker.workers.dev API_KEY=sk_... npx tsx scripts/test-embed.ts
 *
 * Note: Rate limiting tests are not included as they require 30+ requests per endpoint
 * and would significantly slow down the test suite. To test rate limits manually:
 *   - Text endpoint: 30 req/min per tenant
 *   - Image endpoint: 15 req/min per tenant
 *   - Doc endpoint: 10 req/min per tenant
 */

const API_URL = process.env.API_URL || 'http://127.0.0.1:9004';
const ADMIN_KEY = process.env.ADMIN_KEY || 'ew-local-admin-key-change-me';
const TENANT_ID = 'test-tenant';
const TENANT_NAME = 'Test Tenant';

let API_KEY = process.env.API_KEY || '';

// ─── helpers ────────────────────────────────────────────────────────────────

function pass(label: string) { console.log(`  ✅ ${label}`); }
function fail(label: string, detail?: unknown) {
  console.error(`  ❌ ${label}${detail !== undefined ? ` [${JSON.stringify(detail).slice(0, 120)}]` : ''}`);
}

async function post(path: string, body: unknown, auth: 'bearer' | 'admin') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth === 'bearer') headers['Authorization'] = `Bearer ${API_KEY}`;
  if (auth === 'admin')  headers['X-Admin-Key'] = ADMIN_KEY;
  return fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function del(path: string) {
  return fetch(`${API_URL}${path}`, {
    method: 'DELETE',
    headers: { 'X-Admin-Key': ADMIN_KEY },
  });
}

// ─── tests ──────────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\n[health]');
  const res = await fetch(`${API_URL}/health`);
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || data.status !== 'ok') { fail('GET /health', data); return; }
  if (typeof data.version !== 'string') fail('health → version missing');
  else if (typeof data.timestamp !== 'string' || isNaN(Date.parse(data.timestamp as string))) fail('health → timestamp invalid');
  else pass(`GET /health → ok (version=${data.version})`);
}

async function setupTenant(): Promise<boolean> {
  console.log('\n[admin] setup tenant');

  // Delete if exists (ignore errors)
  await del(`/admin/tenant?id=${TENANT_ID}`);

  const res = await post('/admin/tenant', { id: TENANT_ID, name: TENANT_NAME }, 'admin');
  const data = await res.json() as Record<string, unknown>;

  if (res.status === 201 && typeof data.api_key === 'string') {
    API_KEY = data.api_key as string;
    pass(`Created tenant '${TENANT_ID}', got API key`);
    return true;
  }
  fail('POST /admin/tenant', data);
  return false;
}

async function testTextEmbed() {
  console.log('\n[text]');

  // Plain string — full success shape
  {
    const res = await post('/embeddings/text', { input: 'Software engineer with 5 years of React experience' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.embedding)) { fail('plain string', data); }
    else {
      const emb = data.embedding as number[];
      if (data.success !== true) fail('plain string → success should be true');
      else if (data.model !== 'gemini-embedding-2-preview') fail(`plain string → unexpected model: ${data.model}`);
      else if (typeof data.dimensions !== 'number' || emb.length !== data.dimensions) fail(`plain string → dimensions mismatch: declared=${data.dimensions} actual=${emb.length}`);
      else if (data.task_type !== 'RETRIEVAL_DOCUMENT') fail(`plain string → default task_type should be RETRIEVAL_DOCUMENT, got ${data.task_type}`);
      else if (!emb.every(v => typeof v === 'number' && isFinite(v))) fail('plain string → embedding contains non-finite values');
      else if (emb.every(v => v === 0)) fail('plain string → embedding is all zeros');
      else if (typeof (data.usage as Record<string, unknown>)?.estimated_cost_usd !== 'number') fail('plain string → estimated_cost_usd missing');
      else if (typeof data.request_id !== 'string') fail('plain string → request_id missing');
      else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0) fail('plain string → latency_ms invalid');
      else pass(`plain string → embedding (model=${data.model}, dims=${data.dimensions}, task_type=${data.task_type})`);
    }
  }

  // Object input
  {
    const res = await post('/embeddings/text', {
      input: { name: 'Jane Smith', title: 'Senior Backend Engineer', skills: ['Rust', 'Go', 'PostgreSQL'] },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`object input → embedding (model=${data.model})`);
    else fail('object input', data);
  }

  // Array of strings
  {
    const res = await post('/embeddings/text', {
      input: ['machine learning', 'natural language processing', 'vector databases'],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`string array → single embedding (model=${data.model})`);
    else fail('string array', data);
  }

  // Mixed array (strings + objects)
  {
    const res = await post('/embeddings/text', {
      input: ['Python developer', { skill: 'FastAPI', years: 3 }, 'REST API design'],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`mixed array → single embedding (model=${data.model})`);
    else fail('mixed array', data);
  }

  // Stringified JSON input
  {
    const res = await post('/embeddings/text', {
      input: '{"role":"engineer","department":"platform","level":"senior"}',
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`stringified JSON → embedding (model=${data.model})`);
    else fail('stringified JSON', data);
  }

  // task_type: RETRIEVAL_QUERY — echoed back in response
  {
    const res = await post('/embeddings/text', { input: 'find engineers with Go experience', task_type: 'RETRIEVAL_QUERY' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && data.task_type === 'RETRIEVAL_QUERY' && Array.isArray(data.embedding))
      pass(`task_type=RETRIEVAL_QUERY → echoed back`);
    else fail('task_type=RETRIEVAL_QUERY', data);
  }

  // task_type: invalid value → 400
  {
    const res = await post('/embeddings/text', { input: 'test', task_type: 'INVALID_TYPE' }, 'bearer');
    if (res.status === 400) pass('invalid task_type → 400');
    else fail('invalid task_type should be 400', await res.json());
  }

  // model param rejected — text always uses Gemini, no override
  {
    const res = await post('/embeddings/text', { input: 'hello world', model: 'voyage-4-lite' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.status === 400) pass('model param → 400 (not supported)');
    else fail('model param should be 400', data);
  }

  // X-Request-ID passthrough
  {
    const customRequestId = 'test-request-id-12345';
    const res = await fetch(`${API_URL}/embeddings/text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-Request-ID': customRequestId,
      },
      body: JSON.stringify({ input: 'test' }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && data.request_id === customRequestId && res.headers.get('X-Request-ID') === customRequestId)
      pass('X-Request-ID passthrough → echoed back');
    else fail('X-Request-ID passthrough', data);
  }

  // Content-Type enforcement
  {
    const res = await fetch(`${API_URL}/embeddings/text`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ input: 'test' }),
    });
    if (res.status === 415) pass('wrong Content-Type → 415');
    else fail('wrong Content-Type should be 415', await res.json());
  }

  // Validation errors
  {
    const res = await post('/embeddings/text', { input: 'hello', model: 'gpt-4' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.status === 400 && data.errorCode === 'INVALID_INPUT') pass('invalid model → 400');
    else fail('invalid model', data);
  }
  {
    const res = await post('/embeddings/text', { input: '' }, 'bearer');
    if (res.status === 400) pass('empty input → 400');
    else fail('empty input should be 400', await res.json());
  }
  {
    const res = await post('/embeddings/text', {}, 'bearer');
    if (res.status === 400) pass('missing input → 400');
    else fail('missing input should be 400', await res.json());
  }
  {
    const res = await fetch(`${API_URL}/embeddings/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'test' }),
    });
    if (res.status === 401) pass('no auth → 401');
    else fail('no auth should be 401', await res.json());
  }
}

async function testImageEmbed() {
  console.log('\n[image]');

  // Single URL — full success shape
  {
    const res = await post('/embeddings/image', {
      input: { type: 'url', data: 'https://www.gstatic.com/webp/gallery/1.jpg' },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.embedding)) { fail('single URL', data); }
    else {
      const emb = data.embedding as number[];
      if (data.success !== true) fail('single URL → success should be true');
      else if (data.model !== 'gemini-embedding-2-preview') fail(`single URL → unexpected model: ${data.model}`);
      else if (typeof data.dimensions !== 'number' || emb.length !== data.dimensions) fail(`single URL → dimensions mismatch: declared=${data.dimensions} actual=${emb.length}`);
      else if (!emb.every(v => typeof v === 'number' && isFinite(v))) fail('single URL → embedding contains non-finite values');
      else if (emb.every(v => v === 0)) fail('single URL → embedding is all zeros');
      else if (typeof (data.usage as Record<string, unknown>)?.estimated_cost_usd !== 'number') fail('single URL → estimated_cost_usd missing');
      else if (typeof data.request_id !== 'string') fail('single URL → request_id missing');
      else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0) fail('single URL → latency_ms invalid');
      // single image → flat embedding/dimensions (not embeddings array)
      else if ('embeddings' in data) fail('single URL → should return flat embedding, not embeddings array');
      else pass(`single URL → embedding (model=${data.model}, dims=${data.dimensions})`);
    }
  }

  // Batch of 2 URLs — returns embeddings array with index/embedding/dimensions per item
  {
    const res = await post('/embeddings/image', {
      input: [
        { type: 'url', data: 'https://www.gstatic.com/webp/gallery/1.jpg' },
        { type: 'url', data: 'https://www.gstatic.com/webp/gallery/2.jpg' },
      ],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.embeddings)) { fail('batch 2 URLs', data); }
    else {
      const embeddings = data.embeddings as { index: number; embedding: number[]; dimensions: number }[];
      const indexes = embeddings.map(e => e.index).sort((a, b) => a - b);
      const contiguous = indexes.every((idx, i) => idx === i);
      const dims = embeddings.map(e => e.embedding.length);
      const uniformDims = dims.every(d => d === dims[0]);
      if (embeddings.length !== 2) fail(`batch 2 URLs → expected 2 embeddings, got ${embeddings.length}`);
      else if (!contiguous) fail(`batch 2 URLs → indexes not contiguous: ${JSON.stringify(indexes)}`);
      else if (!uniformDims) fail(`batch 2 URLs → mixed dimensions`);
      else if ('embedding' in data) fail('batch 2 URLs → should return embeddings array, not flat embedding');
      else pass(`batch 2 URLs → ${embeddings.length} embeddings, dims=${dims[0]}`);
    }
  }

  // Model override — model param is not supported, expect 400
  {
    const res = await post('/embeddings/image', {
      input: { type: 'url', data: 'https://www.gstatic.com/webp/gallery/1.jpg' },
      model: 'voyage-multimodal-3',
    }, 'bearer');
    if (res.status === 400) pass('model override → 400 (not supported)');
    else fail('model override', await res.json());
  }

  // Invalid URL scheme
  {
    const res = await post('/embeddings/image', {
      input: { type: 'url', data: 'ftp://example.com/image.jpg' },
    }, 'bearer');
    if (res.status === 400) pass('ftp URL → 400');
    else fail('ftp URL should be 400', await res.json());
  }

  // Private IP
  {
    const res = await post('/embeddings/image', {
      input: { type: 'url', data: 'http://192.168.1.1/image.jpg' },
    }, 'bearer');
    if (res.status === 400) pass('private IP URL → 400');
    else fail('private IP should be 400', await res.json());
  }

  // Single base64 PNG — full success shape
  {
    // 1x1 red pixel PNG, base64 encoded
    const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABwAAAA4CAIAAABhUg/jAAAAMklEQVR4nO3MQREAMAgAoLkoFreTiSzhy4MARGe9bX99lEqlUqlUKpVKpVKpVCqVHksHaBwCA2cPf0cAAAAASUVORK5CYII=';
    const res = await post('/embeddings/image', {
      input: { type: 'base64', data: tinyPngBase64, mediaType: 'image/png' },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.embedding)) { fail('base64 PNG', data); }
    else {
      const emb = data.embedding as number[];
      if (data.success !== true) fail('base64 PNG → success should be true');
      else if (data.model !== 'gemini-embedding-2-preview') fail(`base64 PNG → unexpected model: ${data.model}`);
      else if (typeof data.dimensions !== 'number' || emb.length !== data.dimensions) fail(`base64 PNG → dimensions mismatch: declared=${data.dimensions} actual=${emb.length}`);
      else if (!emb.every(v => typeof v === 'number' && isFinite(v))) fail('base64 PNG → embedding contains non-finite values');
      else if (emb.every(v => v === 0)) fail('base64 PNG → embedding is all zeros');
      else if (typeof (data.usage as Record<string, unknown>)?.estimated_cost_usd !== 'number') fail('base64 PNG → estimated_cost_usd missing');
      else if (typeof data.request_id !== 'string') fail('base64 PNG → request_id missing');
      else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0) fail('base64 PNG → latency_ms invalid');
      else pass(`base64 PNG → embedding (dims=${data.dimensions})`);
    }
  }

  // Unsupported mediaType on base64 (gif is not supported by Gemini embedding)
  {
    const res = await post('/embeddings/image', {
      input: { type: 'base64', data: 'abc123', mediaType: 'image/gif' },
    }, 'bearer');
    if (res.status === 400) pass('base64 unsupported mediaType (gif) → 400');
    else fail('base64 gif should be 400', await res.json());
  }

  // Missing mediaType on base64
  {
    const res = await post('/embeddings/image', {
      input: { type: 'base64', data: 'abc123' },
    }, 'bearer');
    if (res.status === 400) pass('base64 missing mediaType → 400');
    else fail('base64 missing mediaType should be 400', await res.json());
  }

  // Batch exceeds limit (MAX_IMAGE_BATCH_SIZE = 5)
  {
    const items = Array.from({ length: 6 }, (_, i) => ({
      type: 'url', data: `https://example.com/img${i}.jpg`,
    }));
    const res = await post('/embeddings/image', { input: items }, 'bearer');
    if (res.status === 400) pass('batch > 5 → 400');
    else fail('batch > 5 should be 400', await res.json());
  }
}

// ─── fetch PDFs for doc tests ─────────────────────────────────────────────────

async function fetchSamplePdfBase64(): Promise<string | null> {
  try {
    const res = await fetch('https://pdfobject.com/pdf/sample.pdf');
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch {
    return null;
  }
}




async function testDocEmbed() {
  console.log('\n[doc]');

  // ── validation-only (no provider calls) ───────────────────────────────────

  // Missing mimeType
  {
    const res = await post('/embeddings/doc', { input: { data: 'dGVzdA==' } }, 'bearer');
    if (res.status === 400) pass('missing mimeType → 400');
    else fail('missing mimeType should be 400', await res.json());
  }

  // Invalid mimeType
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'text/plain', data: 'dGVzdA==' } }, 'bearer');
    if (res.status === 400) pass('invalid mimeType → 400');
    else fail('invalid mimeType should be 400', await res.json());
  }

  // Missing data
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf' } }, 'bearer');
    if (res.status === 400) pass('missing data → 400');
    else fail('missing data should be 400', await res.json());
  }

  // Invalid base64
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: '!!!not-base64!!!' } }, 'bearer');
    if (res.status === 400) pass('invalid base64 → 400');
    else fail('invalid base64 should be 400', await res.json());
  }

  // max_pages=0 (must be positive integer)
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, max_pages: 0 }, 'bearer');
    if (res.status === 400) pass('max_pages=0 → 400');
    else fail('max_pages=0 should be 400', await res.json());
  }

  // max_pages=7 (PDF) — not supported, always 400
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, max_pages: 7 }, 'bearer');
    if (res.status === 400) pass('max_pages=7 (PDF) → 400 (not supported for PDFs)');
    else fail('max_pages=7 on PDF should be 400', await res.json());
  }

  // max_pages=1 (PDF) — also not supported
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, max_pages: 1 }, 'bearer');
    if (res.status === 400) pass('max_pages=1 (PDF) → 400 (not supported for PDFs)');
    else fail('max_pages=1 on PDF should be 400', await res.json());
  }

  // model param rejected
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, model: 'voyage-multimodal-3.5' }, 'bearer');
    if (res.status === 400) pass('model param on doc → 400');
    else fail('model param on doc should be 400', await res.json());
  }

  // Missing input entirely
  {
    const res = await post('/embeddings/doc', {}, 'bearer');
    if (res.status === 400) pass('missing input → 400');
    else fail('missing input should be 400', await res.json());
  }

  // ── provider tests ────────────────────────────────────────────────────────

  process.stdout.write('  Fetching sample PDF...');
  const pdfBase64 = await fetchSamplePdfBase64();
  if (!pdfBase64) {
    console.log(' skipped (could not fetch sample PDF — check network)');
    return;
  }
  console.log(` ok (${Math.round(pdfBase64.length * 0.75 / 1024)}KB)`);

  // PDF embed — full success assertions
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'test.pdf' },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.embeddings)) {
      fail('PDF embed', data);
    } else {
      const embeddings = data.embeddings as { index: number; embedding: number[]; dimensions: number }[];
      const doc = data.document as Record<string, unknown>;
      const usage = data.usage as Record<string, unknown>;

      // embedding shape
      if (embeddings.length !== 1)
        fail(`PDF → expected 1 embedding, got ${embeddings.length}`);
      else if (embeddings[0].index !== 0)
        fail(`PDF → expected index=0, got ${embeddings[0].index}`);
      else if (embeddings[0].dimensions !== 3072)
        fail(`PDF → expected dims=3072, got ${embeddings[0].dimensions}`);
      else if (embeddings[0].embedding.length !== embeddings[0].dimensions)
        fail('PDF → embedding length does not match dimensions field');
      // embedding values are real floats, not all zeros
      else if (!embeddings[0].embedding.every(v => typeof v === 'number' && isFinite(v)))
        fail('PDF → embedding contains non-finite values');
      else if (embeddings[0].embedding.every(v => v === 0))
        fail('PDF → embedding is all zeros');
      // response envelope
      else if (data.success !== true)
        fail(`PDF → success should be true, got ${data.success}`);
      else if (data.model !== 'gemini-embedding-2-preview')
        fail(`PDF → unexpected model: ${data.model}`);
      else if (typeof data.request_id !== 'string')
        fail('PDF → request_id missing');
      else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0)
        fail('PDF → latency_ms missing or negative');
      // usage
      else if (typeof usage?.total_tokens !== 'number' || usage.total_tokens <= 0)
        fail('PDF → total_tokens should be > 0');
      else if (typeof usage?.estimated_cost_usd !== 'number')
        fail('PDF → estimated_cost_usd missing');
      // document metadata
      else if (doc?.chunks !== 1)
        fail(`PDF → doc.chunks should be 1, got ${doc?.chunks}`);
      else if (doc?.mimeType !== 'application/pdf')
        fail(`PDF → doc.mimeType should be application/pdf, got ${doc?.mimeType}`);
      else if (doc?.type !== 'PDF')
        fail(`PDF → doc.type should be "PDF", got ${doc?.type}`);
      else if (doc?.filename !== 'test.pdf')
        fail(`PDF → doc.filename should be "test.pdf", got ${doc?.filename}`);
      // must NOT have DOCX/XLSX-only fields
      else if (doc?.max_pages !== undefined)
        fail(`PDF → doc.max_pages should be absent, got ${doc.max_pages}`);
      else if (doc?.total_chars !== undefined)
        fail(`PDF → doc.total_chars should be absent, got ${doc.total_chars}`);
      else
        pass(`PDF embed → dims=${embeddings[0].dimensions}, tokens=${usage.total_tokens}, cost=${usage.estimated_cost_usd}`);
    }
  }

  // filename sanitisation — special chars replaced with underscores
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'my file (v2).pdf' },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    const doc = data.document as Record<string, unknown> | undefined;
    if (res.ok && typeof doc?.filename === 'string' && !doc.filename.includes(' ') && !doc.filename.includes('('))
      pass(`PDF filename sanitised → "${doc.filename}"`);
    else fail('PDF filename sanitisation', data);
  }

  // default filename when omitted
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64 },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    const doc = data.document as Record<string, unknown> | undefined;
    if (res.ok && doc?.filename === 'document.pdf')
      pass('PDF default filename → document.pdf');
    else fail('PDF default filename', data);
  }
}

async function testAdminRoutes() {
  console.log('\n[admin]');

  // Get tenant
  {
    const res = await fetch(`${API_URL}/admin/tenant?id=${TENANT_ID}`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && data.tenant_id === TENANT_ID) pass('GET /admin/tenant → found');
    else fail('GET /admin/tenant', data);
  }

  // Get nonexistent tenant
  {
    const res = await fetch(`${API_URL}/admin/tenant?id=nonexistent-tenant-xyz`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    if (res.status === 404) pass('GET /admin/tenant (nonexistent) → 404');
    else fail('GET /admin/tenant (nonexistent) should be 404', await res.json());
  }

  // List tenants
  {
    const res = await fetch(`${API_URL}/admin/tenants`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.tenants) && typeof data.count === 'number') pass('GET /admin/tenants → list with count');
    else fail('GET /admin/tenants', data);
  }

  // List tenants with pagination — seed a second tenant so limit=1 is actually exercised
  {
    const secondId = 'test-tenant-pagination-seed';
    await del(`/admin/tenant?id=${secondId}`);
    await post('/admin/tenant', { id: secondId, name: 'Pagination Seed' }, 'admin');

    const res = await fetch(`${API_URL}/admin/tenants?limit=1`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const data = await res.json() as Record<string, unknown>;
    const tenants = data.tenants as unknown[];
    if (res.ok && Array.isArray(tenants) && tenants.length === 1 && typeof data.next_cursor === 'string') {
      pass('GET /admin/tenants?limit=1 → exactly 1 result + next_cursor');
    } else {
      fail('GET /admin/tenants?limit=1', data);
    }

    // Clean up seed tenant
    await del(`/admin/tenant?id=${secondId}`);
  }

  // Duplicate tenant
  {
    const res = await post('/admin/tenant', { id: TENANT_ID, name: 'Duplicate' }, 'admin');
    if (res.status === 409) pass('duplicate tenant → 409');
    else fail('duplicate should be 409', await res.json());
  }

  // Invalid tenant ID
  {
    const res = await post('/admin/tenant', { id: 'INVALID ID!', name: 'Bad' }, 'admin');
    if (res.status === 400) pass('invalid tenant ID → 400');
    else fail('invalid tenant ID should be 400', await res.json());
  }

  // Wrong HTTP method on admin route
  {
    const res = await fetch(`${API_URL}/admin/tenant`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', name: 'Test' }),
    });
    if (res.status === 405) pass('PUT /admin/tenant → 405');
    else fail('PUT /admin/tenant should be 405', await res.json());
  }

  // Wrong admin key
  {
    const res = await fetch(`${API_URL}/admin/tenants`, {
      headers: { 'X-Admin-Key': 'wrong-key' },
    });
    if (res.status === 401) pass('wrong admin key → 401');
    else fail('wrong admin key should be 401', await res.json());
  }

  // Delete nonexistent tenant
  {
    const res = await del(`/admin/tenant?id=nonexistent-tenant-xyz`);
    if (res.status === 404) pass('DELETE /admin/tenant (nonexistent) → 404');
    else fail('DELETE /admin/tenant (nonexistent) should be 404', await res.json());
  }
}

async function teardown() {
  console.log('\n[cleanup]');
  const res = await del(`/admin/tenant?id=${TENANT_ID}`);
  const data = await res.json() as Record<string, unknown>;
  if (res.ok) pass(`Deleted tenant '${TENANT_ID}'`);
  else fail('DELETE /admin/tenant', data);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nEmbedding Worker Test Suite`);
  console.log(`Target: ${API_URL}`);

  try {
    await testHealth();

    const ready = await setupTenant();
    if (!ready) {
      console.error('\nCannot proceed without a valid API key. Aborting.');
      process.exit(1);
    }

    await testTextEmbed();
    await testImageEmbed();
    await testDocEmbed();
    await testAdminRoutes();
    await teardown();

    console.log('\nDone.\n');
  } catch (err) {
    console.error('\nUnexpected error:', err);
    process.exit(1);
  }
}

main();
