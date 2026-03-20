/**
 * Test script for the Embedding Worker
 *
 * Usage:
 *   1. Start the worker locally: npm run dev
 *   2. Run: npx tsx scripts/test-embed.ts
 *
 * Override defaults via env vars:
 *   API_URL=https://embedding-worker.workers.dev API_KEY=sk_... npx tsx scripts/test-embed.ts
 */

const API_URL = process.env.API_URL || 'http://127.0.0.1:9004';
const ADMIN_KEY = process.env.ADMIN_KEY || 'ew-local-admin-key-change-me';
const TENANT_ID = 'test-tenant';
const TENANT_NAME = 'Test Tenant';

let API_KEY = process.env.API_KEY || '';

// ─── helpers ────────────────────────────────────────────────────────────────

function pass(label: string) { console.log(`  ✅ ${label}`); }
function fail(label: string, detail?: unknown) {
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error('     ', JSON.stringify(detail, null, 2));
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
    if (res.ok && Array.isArray(data.embedding)) pass(`plain string → embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    else fail('plain string', data);
  }

  // Object input
  {
    const res = await post('/embeddings/text', {
      input: { name: 'Jane Smith', title: 'Senior Backend Engineer', skills: ['Rust', 'Go', 'PostgreSQL'] },
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`object input → embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    else fail('object input', data);
  }

  // Array of strings
  {
    const res = await post('/embeddings/text', {
      input: ['machine learning', 'natural language processing', 'vector databases'],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`string array → single embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    else fail('string array', data);
  }

  // Mixed array (strings + objects)
  {
    const res = await post('/embeddings/text', {
      input: ['Python developer', { skill: 'FastAPI', years: 3 }, 'REST API design'],
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`mixed array → single embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    else fail('mixed array', data);
  }

  // Stringified JSON input
  {
    const res = await post('/embeddings/text', {
      input: '{"role":"engineer","department":"platform","level":"senior"}',
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embedding)) pass(`stringified JSON → embedding (model=${data.model}${data.fallback_provider ? ', fallback=' + data.fallback_provider : ''})`);
    else fail('stringified JSON', data);
  }

  // Model override
  {
    const res = await post('/embeddings/text', { input: 'hello world', model: 'voyage-4-lite' }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && (data.model === 'voyage-4-lite' || data.fallback_provider === 'openai')) pass(`model override → ${data.model}`);
    else fail('model override', data);
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
    if (res.ok && Array.isArray(data.embedding)) pass('single URL → embedding');
    else fail('single URL', data);
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

// ─── fetch a real small PDF for doc tests ────────────────────────────────────
// Using a well-known tiny public PDF (W3C spec sample, ~7KB, single page, text layer)
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

  process.stdout.write('  Fetching sample PDF...');
  const pdfBase64 = await fetchSamplePdfBase64();
  if (!pdfBase64) {
    console.log(' skipped (could not fetch sample PDF — check network)');
    return;
  }
  console.log(` ok (${Math.round(pdfBase64.length * 0.75 / 1024)}KB)`);

  // Valid PDF
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

  // With model override
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64 },
      model: 'voyage-4-lite',
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && (data.model === 'voyage-4-lite' || data.fallback_provider === 'openai')) pass(`model override → ${data.model}`);
    else fail('model override', data);
  }

  // With max_pages
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'paged.pdf' },
      max_pages: 1,
    }, 'bearer');
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.embeddings)) pass('max_pages=1 → ok');
    else fail('max_pages', data);
  }

  // Validation-only — no provider calls, no delay needed

  // Missing mimeType
  {
    const res = await post('/embeddings/doc', {
      input: { data: pdfBase64 },
    }, 'bearer');
    if (res.status === 400) pass('missing mimeType → 400');
    else fail('missing mimeType should be 400', await res.json());
  }

  // Invalid mimeType
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'text/plain', data: pdfBase64 },
    }, 'bearer');
    if (res.status === 400) pass('invalid mimeType → 400');
    else fail('invalid mimeType should be 400', await res.json());
  }

  // Missing data
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf' },
    }, 'bearer');
    if (res.status === 400) pass('missing data → 400');
    else fail('missing data should be 400', await res.json());
  }

  // Invalid base64
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: '!!!not-base64!!!' },
    }, 'bearer');
    if (res.status === 400) pass('invalid base64 → 400');
    else fail('invalid base64 should be 400', await res.json());
  }

  // max_pages out of range
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64 },
      max_pages: 0,
    }, 'bearer');
    if (res.status === 400) pass('max_pages=0 → 400');
    else fail('max_pages=0 should be 400', await res.json());
  }

  // Invalid model
  {
    const res = await post('/embeddings/doc', {
      input: { mimeType: 'application/pdf', data: pdfBase64 },
      model: 'voyage-multimodal-3.5',
    }, 'bearer');
    if (res.status === 400) pass('image model on doc → 400');
    else fail('image model on doc should be 400', await res.json());
  }

  // Missing input entirely
  {
    const res = await post('/embeddings/doc', {}, 'bearer');
    if (res.status === 400) pass('missing input → 400');
    else fail('missing input should be 400', await res.json());
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

  // List tenants
  {
    const res = await fetch(`${API_URL}/admin/tenants`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const data = await res.json() as Record<string, unknown>;
    if (res.ok && Array.isArray(data.tenants)) pass('GET /admin/tenants → list');
    else fail('GET /admin/tenants', data);
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

  // Wrong admin key
  {
    const res = await fetch(`${API_URL}/admin/tenants`, {
      headers: { 'X-Admin-Key': 'wrong-key' },
    });
    if (res.status === 401) pass('wrong admin key → 401');
    else fail('wrong admin key should be 401', await res.json());
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
