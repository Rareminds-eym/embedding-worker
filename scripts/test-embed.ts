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
  if (res.ok && data.status === 'ok') pass('GET /health → ok');
  else fail('GET /health', data);
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

  // Plain string
  {
    const res = await post('/embeddings/text', { input: 'Software engineer with 5 years of React experience' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) {
      const emb = data.embedding as number[];
      if (typeof data.dimensions === 'number' && emb.length !== data.dimensions)
        fail(`plain string → dimensions mismatch: declared=${data.dimensions} actual=${emb.length}`);
      else {

        pass(`plain string → embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
      }
    } else fail('plain string', data);
  }

  // Object input
  {
    const res = await post('/embeddings/text', {
      input: { name: 'Jane Smith', title: 'Senior Backend Engineer', skills: ['Rust', 'Go', 'PostgreSQL'] },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) {

      pass(`object input → embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    }
    else fail('object input', data);
  }

  // Array of strings
  {
    const res = await post('/embeddings/text', {
      input: ['machine learning', 'natural language processing', 'vector databases'],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) {

      pass(`string array → single embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    }
    else fail('string array', data);
  }

  // Mixed array (strings + objects)
  {
    const res = await post('/embeddings/text', {
      input: ['Python developer', { skill: 'FastAPI', years: 3 }, 'REST API design'],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) {

      pass(`mixed array → single embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    }
    else fail('mixed array', data);
  }

  // Stringified JSON input
  {
    const res = await post('/embeddings/text', {
      input: '{"role":"engineer","department":"platform","level":"senior"}',
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) {

      pass(`stringified JSON → embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    }
    else fail('stringified JSON', data);
  }

  // Model override
  {
    const res = await post('/embeddings/text', { input: 'hello world', model: 'voyage-4-lite' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && (data.model === 'voyage-4-lite' || data.fallback_provider === 'openai')) {

      pass(`model override → ${data.model}`);
    }
    else fail('model override', data);
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
    if (
      res.ok &&
      data.request_id === customRequestId &&
      res.headers.get('X-Request-ID') === customRequestId
    ) {

      pass('X-Request-ID passthrough → echoed back');
    } else fail('X-Request-ID passthrough', data);
  }

  // Content-Type enforcement
  {
    const res = await fetch(`${API_URL}/embeddings/text`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ input: 'test' }),
    });
    if (res.status === 415) pass('wrong Content-Type → 415');
    else fail('wrong Content-Type should be 415', await res.json());
  }

  // Validation-only (no provider calls)
  {
    const res = await post('/embeddings/text', { input: 'hello', model: 'gpt-4' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.status === 400 && data.errorCode === 'INVALID_INPUT') pass('invalid model → 400');
    else fail('invalid model', data);
  }

  {
    const res = await post('/embeddings/text', { input: '' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.status === 400) pass('empty input → 400');
    else fail('empty input should be 400', data);
  }

  {
    const res = await post('/embeddings/text', {}, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.status === 400) pass('missing input → 400');
    else fail('missing input should be 400', data);
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

  // Single URL — using a stable, small public image with Content-Length
  {
    const res = await post('/embeddings/image', {
      input: { type: 'url', data: 'https://www.gstatic.com/webp/gallery/1.jpg' },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) {

      pass('single URL → embedding');
    }
    else fail('single URL', data);
  }

  // Model override
  {
    const res = await post('/embeddings/image', {
      input: { type: 'url', data: 'https://www.gstatic.com/webp/gallery/1.jpg' },
      model: 'voyage-multimodal-3',
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && data.model === 'voyage-multimodal-3') {

      pass(`model override → ${data.model}`);
    }
    else fail('model override', data);
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

  // Missing mediaType on base64
  {
    const res = await post('/embeddings/image', {
      input: { type: 'base64', data: 'abc123' },
    }, 'bearer');
    if (res.status === 400) pass('base64 missing mediaType → 400');
    else fail('base64 missing mediaType should be 400', await res.json());
  }

  // Batch exceeds limit
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

  // ── validation-only tests first — these must run before provider calls
  // to avoid hitting the 10 req/min rate limit on /doc ──────────────────────

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

  // max_pages out of range
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, max_pages: 0 }, 'bearer');
    if (res.status === 400) pass('max_pages=0 → 400');
    else fail('max_pages=0 should be 400', await res.json());
  }

  // Invalid model (image model on doc endpoint)
  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, model: 'voyage-multimodal-3.5' }, 'bearer');
    if (res.status === 400) pass('image model on doc → 400');
    else fail('image model on doc should be 400', await res.json());
  }

  // Missing input entirely
  {
    const res = await post('/embeddings/doc', {}, 'bearer');
    if (res.status === 400) pass('missing input → 400');
    else fail('missing input should be 400', await res.json());
  }

  // ── provider tests — fetch real PDFs ──────────────────────────────────────

  process.stdout.write('  Fetching sample PDF...');
  const pdfBase64 = await fetchSamplePdfBase64();
  if (!pdfBase64) {
    console.log(' skipped (could not fetch sample PDF — check network)');
    return;
  }
  console.log(` ok (${Math.round(pdfBase64.length * 0.75 / 1024)}KB)`);

  // Valid single-chunk PDF
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'test.pdf' },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embeddings)) {
      const doc = data.document as Record<string, unknown>;

      pass(`PDF → ${(data.embeddings as unknown[]).length} chunk(s), model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''}, chars=${doc?.total_chars}`);
    } else fail('PDF embed', data);
  }

  // Model override on single-chunk
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64 },
      model: 'voyage-4-lite',
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && data.model === 'voyage-4-lite') {

      pass(`model override → ${data.model}`);
    } else fail('model override', data);
  }

  // max_pages=1
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'paged.pdf' },
      max_pages: 1,
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embeddings)) {

      pass('max_pages=1 → ok');
    } else fail('max_pages', data);
  }

  // ── max_pages=3 tests — reuse the already-fetched pdfBase64, no extra network calls ──

  // Structural integrity: contiguous indexes, uniform dimensions, doc.chunks matches embedding count
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'multi.pdf' },
      max_pages: 3,
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || !Array.isArray(data.embeddings)) {
      fail('max_pages=3 embed', { status: res.status, errorCode: (data as Record<string, unknown>).errorCode });
    } else {
      const embeddings = data.embeddings as { index: number; embedding: number[] }[];
      const doc = data.document as Record<string, unknown>;
      const chunkCount = embeddings.length;
      const indexes = embeddings.map(e => e.index).sort((a, b) => a - b);
      const contiguous = indexes.every((idx, i) => idx === i);
      const dims = embeddings.map(e => e.embedding.length);
      const uniformDims = dims.every(d => d === dims[0]);
      const chunksMatch = doc?.chunks === chunkCount;

      if (!contiguous) fail(`max_pages=3 → indexes not contiguous: ${JSON.stringify(indexes)}`);
      else if (!uniformDims) fail(`max_pages=3 → mixed dimensions: ${JSON.stringify([...new Set(dims)])}`);
      else if (!chunksMatch) fail(`max_pages=3 → doc.chunks=${doc?.chunks} but got ${chunkCount} embeddings`);
      else pass(`max_pages=3 → ${chunkCount} chunk(s), dims=${dims[0]}, chars=${doc?.total_chars}, model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''}`);
    }
  }

  // model override with max_pages=3
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'multi-model.pdf' },
      model: 'voyage-4-lite',
      max_pages: 3,
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embeddings)) {
      pass(`max_pages=3 model override → ${(data.embeddings as unknown[]).length} chunk(s), model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''}`);
    } else {
      fail('max_pages=3 model override', { status: res.status, errorCode: (data as Record<string, unknown>).errorCode });
    }
  }

  // total_tokens > 0 with max_pages=3
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'multi-tokens.pdf' },
      max_pages: 3,
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    const usage = data.usage as Record<string, unknown> | undefined;
    if (res.ok && typeof usage?.total_tokens === 'number' && usage.total_tokens > 0) {
      pass(`max_pages=3 usage → total_tokens=${usage.total_tokens}`);
    } else {
      fail('max_pages=3 usage total_tokens should be > 0', { status: res.status, errorCode: (data as Record<string, unknown>).errorCode });
    }
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
