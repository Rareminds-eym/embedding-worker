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
const ADMIN_KEY = process.env.ADMIN_KEY || 'ew-local-admin-key-change-me-32chars';
const TENANT_ID = 'test-tenant';
const TENANT_NAME = 'Test Tenant';

let API_KEY = process.env.API_KEY || '';

interface EmbeddingResult {
  index: number;
  embedding: number[];
  dimensions: number;
}

interface DocumentMetadata {
  filename?: string;
  mimeType?: string;
  type?: string;
  chunks?: number;
  total_chars?: number;
  chunk_size?: number;
  chunk_overlap?: number;
  pages_detected?: number;
  pages_processed?: number;
}

interface ApiResponse {
  success?: boolean;
  model?: string;
  embedding?: number[];
  embeddings?: EmbeddingResult[];
  document?: DocumentMetadata;
  request_id?: string;
  latency_ms?: number;
  task_type?: string;
  dimensions?: number;
  errorCode?: string;
  message?: string;
  api_key?: string;
  status?: string;
  version?: string;
  timestamp?: string;
  tenant_id?: string;
  tenants?: unknown[];
  count?: number;
  next_cursor?: string;
}

const EXPECTED_DIMENSIONS = 3072;
const EXPECTED_MODEL = 'gemini-embedding-2-preview';
const FETCH_TIMEOUT_MS = 10_000;
const BASE64_TO_BYTES_RATIO = 0.75;
const MAX_IMAGE_BATCH_SIZE = 6;

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
  return fetch(`${API_URL}${path}`, { method: 'DELETE', headers: { 'X-Admin-Key': ADMIN_KEY } });
}

async function testHealth() {
  console.log('\n[health]');
  const res = await fetch(`${API_URL}/health`);
  const data = await res.json() as ApiResponse;
  if (!res.ok || data.status !== 'ok') { fail('GET /health', data); return; }
  if (typeof data.version !== 'string') fail('health → version missing');
  else if (typeof data.timestamp !== 'string' || isNaN(Date.parse(data.timestamp))) fail('health → timestamp invalid');
  else pass(`GET /health → ok (version=${data.version})`);
}

async function setupTenant(): Promise<boolean> {
  console.log('\n[admin] setup tenant');
  await del(`/admin/tenant?id=${TENANT_ID}`);
  const res = await post('/admin/tenant', { id: TENANT_ID, name: TENANT_NAME }, 'admin');
  const data = await res.json() as ApiResponse;
  if (res.status === 201 && typeof data.api_key === 'string') {
    API_KEY = data.api_key;
    pass(`Created tenant '${TENANT_ID}', got API key`);
    return true;
  }
  fail('POST /admin/tenant', data);
  return false;
}

async function testTextEmbed() {
  console.log('\n[text]');

  {
    const res = await post('/embeddings/text', { input: 'Software engineer with 5 years of React experience' }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (!res.ok || !Array.isArray(data.embedding)) { fail('plain string', data); return; }
    const emb = data.embedding;
    if (data.success !== true) fail('plain string → success should be true');
    else if (data.model !== EXPECTED_MODEL) fail(`plain string → unexpected model: ${data.model}`);
    else if (typeof data.dimensions !== 'number' || emb.length !== data.dimensions) fail(`plain string → dimensions mismatch`);
    else if (data.task_type !== 'RETRIEVAL_DOCUMENT') fail(`plain string → default task_type should be RETRIEVAL_DOCUMENT`);
    else if (!emb.every(v => typeof v === 'number' && isFinite(v))) fail('plain string → embedding contains non-finite values');
    else if (emb.every(v => v === 0)) fail('plain string → embedding is all zeros');
    else if (typeof data.request_id !== 'string') fail('plain string → request_id missing');
    else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0) fail('plain string → latency_ms invalid');
    else pass(`plain string → embedding (model=${data.model}, dims=${data.dimensions})`);
  }

  {
    const res = await post('/embeddings/text', { input: { name: 'Jane Smith', title: 'Senior Backend Engineer', skills: ['Rust', 'Go'] } }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (res.ok && Array.isArray(data.embedding)) pass(`object input → embedding`);
    else fail('object input', data);
  }

  {
    const res = await post('/embeddings/text', { input: ['Python developer', { skill: 'FastAPI', years: 3 }, 'REST API design'] }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (res.ok && Array.isArray(data.embedding)) pass(`mixed array → single embedding`);
    else fail('mixed array', data);
  }

  {
    const res = await post('/embeddings/text', { input: 'find engineers with Go experience', task_type: 'RETRIEVAL_QUERY' }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (res.ok && data.task_type === 'RETRIEVAL_QUERY' && Array.isArray(data.embedding)) pass(`task_type=RETRIEVAL_QUERY → echoed back`);
    else fail('task_type=RETRIEVAL_QUERY', data);
  }

  {
    const res = await post('/embeddings/text', { input: 'test', task_type: 'INVALID_TYPE' }, 'bearer');
    if (res.status === 400) pass('invalid task_type → 400');
    else fail('invalid task_type should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/text', { input: 'hello world', model: 'voyage-4-lite' }, 'bearer');
    if (res.status === 400) pass('model param → 400 (not supported)');
    else fail('model param should be 400', await res.json());
  }

  {
    const customRequestId = 'test-request-id-12345';
    const res = await fetch(`${API_URL}/embeddings/text`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'X-Request-ID': customRequestId },
      body: JSON.stringify({ input: 'test' }),
    });
    const data = await res.json() as ApiResponse;
    if (res.ok && data.request_id === customRequestId && res.headers.get('X-Request-ID') === customRequestId) pass('X-Request-ID passthrough');
    else fail('X-Request-ID passthrough', data);
  }

  {
    const res = await fetch(`${API_URL}/embeddings/text`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ input: 'test' }),
    });
    if (res.status === 415) pass('wrong Content-Type → 415');
    else fail('wrong Content-Type should be 415', await res.json());
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

interface FetchedImage { data: string; mediaType: 'image/jpeg' | 'image/png' }

async function fetchImageBase64(url: string, mediaType: 'image/jpeg' | 'image/png'): Promise<FetchedImage | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { data: Buffer.from(buf).toString('base64'), mediaType };
  } catch {
    return null;
  }
}

async function testImageEmbed() {
  console.log('\n[image]');

  process.stdout.write('  Fetching sample images...');
  const fetchResults = await Promise.allSettled([
    fetchImageBase64('https://www.gstatic.com/webp/gallery/1.jpg', 'image/jpeg'),
    fetchImageBase64('https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/120px-PNG_transparency_demonstration_1.png', 'image/png'),
  ]);
  const sampleJpeg = fetchResults[0].status === 'fulfilled' ? fetchResults[0].value : null;
  const samplePng  = fetchResults[1].status === 'fulfilled' ? fetchResults[1].value : null;

  if (!sampleJpeg && !samplePng) {
    console.log(' skipped (network unavailable)');
  } else {
    console.log(` ok`);
  }

  if (sampleJpeg) {
    const res = await post('/embeddings/image', { input: { type: 'base64', data: sampleJpeg.data, mediaType: sampleJpeg.mediaType } }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (!res.ok || !Array.isArray(data.embeddings) || data.embeddings.length !== 1) { fail('single image', data); }
    else {
      const emb = data.embeddings[0].embedding;
      if (data.success !== true) fail('single image → success should be true');
      else if (data.model !== EXPECTED_MODEL) fail(`single image → unexpected model`);
      else if (data.embeddings[0].dimensions !== emb.length) fail(`single image → dimensions mismatch`);
      else if (!emb.every(v => typeof v === 'number' && isFinite(v))) fail('single image → non-finite values');
      else if (emb.every(v => v === 0)) fail('single image → all zeros');
      else if (typeof data.request_id !== 'string') fail('single image → request_id missing');
      else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0) fail('single image → latency_ms invalid');
      else pass(`single image → embedding (dims=${data.embeddings[0].dimensions})`);
    }
  } else {
    pass('single image → skipped (network unavailable)');
  }

  if (sampleJpeg && samplePng) {
    const res = await post('/embeddings/image', {
      input: [
        { type: 'base64', data: sampleJpeg.data, mediaType: sampleJpeg.mediaType },
        { type: 'base64', data: samplePng.data, mediaType: samplePng.mediaType },
      ],
    }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (!res.ok || !Array.isArray(data.embeddings)) { fail('batch 2 images', data); }
    else {
      const embeddings = data.embeddings;
      const indexes = embeddings.map(e => e.index).sort((a, b) => a - b);
      const contiguous = indexes.every((idx, i) => idx === i);
      if (embeddings.length !== 2) fail(`batch 2 images → expected 2, got ${embeddings.length}`);
      else if (!contiguous) fail(`batch 2 images → indexes not contiguous`);
      else pass(`batch 2 images → ${embeddings.length} embeddings`);
    }
  } else {
    pass('batch 2 images → skipped (network unavailable)');
  }

  {
    const res = await post('/embeddings/image', { input: { type: 'base64', data: 'aW52YWxpZA==', mediaType: 'image/jpeg' }, model: 'voyage-multimodal-3' }, 'bearer');
    if (res.status === 400) pass('model override → 400');
    else fail('model override should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/image', { input: { type: 'url', data: 'ftp://example.com/image.jpg' } }, 'bearer');
    if (res.status === 400) pass('ftp URL → 400');
    else fail('ftp URL should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/image', { input: { type: 'url', data: 'http://192.168.1.1/image.jpg' } }, 'bearer');
    if (res.status === 400) pass('private IP URL → 400');
    else fail('private IP should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/image', { input: { type: 'base64', data: 'abc123', mediaType: 'image/gif' } }, 'bearer');
    if (res.status === 400) pass('unsupported mediaType (gif) → 400');
    else fail('gif should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/image', { input: { type: 'base64', data: 'abc123' } }, 'bearer');
    if (res.status === 400) pass('missing mediaType → 400');
    else fail('missing mediaType should be 400', await res.json());
  }

  {
    const items = Array.from({ length: MAX_IMAGE_BATCH_SIZE + 1 }, (_, i) => ({ type: 'url', data: `https://example.com/img${i}.jpg` }));
    const res = await post('/embeddings/image', { input: items }, 'bearer');
    if (res.status === 400) pass(`batch > ${MAX_IMAGE_BATCH_SIZE} → 400`);
    else fail(`batch > ${MAX_IMAGE_BATCH_SIZE} should be 400`, await res.json());
  }
}

async function fetchSamplePdfBase64(): Promise<string | null> {
  try {
    const res = await fetch('https://pdfobject.com/pdf/sample.pdf', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch {
    return null;
  }
}

async function testDocEmbed() {
  console.log('\n[doc]');

  {
    const res = await post('/embeddings/doc', { input: { data: 'dGVzdA==' } }, 'bearer');
    if (res.status === 400) pass('missing mimeType → 400');
    else fail('missing mimeType should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'text/plain', data: 'dGVzdA==' } }, 'bearer');
    if (res.status === 400) pass('invalid mimeType → 400');
    else fail('invalid mimeType should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf' } }, 'bearer');
    if (res.status === 400) pass('missing data → 400');
    else fail('missing data should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: '!!!not-base64!!!' } }, 'bearer');
    if (res.status === 400) pass('invalid base64 → 400');
    else fail('invalid base64 should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, max_pages: 0 }, 'bearer');
    if (res.status === 400) pass('max_pages=0 → 400');
    else fail('max_pages=0 should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, max_pages: 1 }, 'bearer');
    if (res.status === 400) pass('max_pages on PDF → 400');
    else fail('max_pages on PDF should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: 'dGVzdA==' }, model: 'voyage-multimodal-3.5' }, 'bearer');
    if (res.status === 400) pass('model param → 400');
    else fail('model param should be 400', await res.json());
  }

  {
    const res = await post('/embeddings/doc', {}, 'bearer');
    if (res.status === 400) pass('missing input → 400');
    else fail('missing input should be 400', await res.json());
  }

  process.stdout.write('  Fetching sample PDF...');
  const pdfBase64 = await fetchSamplePdfBase64();
  if (!pdfBase64) {
    console.log(' skipped (network unavailable)');
    return;
  }
  console.log(` ok (${Math.round(pdfBase64.length * BASE64_TO_BYTES_RATIO / 1024)}KB)`);

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'test.pdf' } }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (!res.ok || !Array.isArray(data.embeddings)) { fail('PDF embed', data); }
    else {
      const embeddings = data.embeddings as EmbeddingResult[];
      const doc = data.document as DocumentMetadata;
      if (embeddings.length !== 1) fail(`PDF → expected 1 embedding, got ${embeddings.length}`);
      else if (embeddings[0].dimensions !== EXPECTED_DIMENSIONS) fail(`PDF → expected dims=${EXPECTED_DIMENSIONS}`);
      else if (embeddings[0].embedding.length !== embeddings[0].dimensions) fail('PDF → embedding length mismatch');
      else if (!embeddings[0].embedding.every(v => typeof v === 'number' && isFinite(v))) fail('PDF → non-finite values');
      else if (embeddings[0].embedding.every(v => v === 0)) fail('PDF → all zeros');
      else if (data.success !== true) fail(`PDF → success should be true`);
      else if (data.model !== EXPECTED_MODEL) fail(`PDF → unexpected model`);
      else if (typeof data.request_id !== 'string') fail('PDF → request_id missing');
      else if (typeof data.latency_ms !== 'number' || data.latency_ms < 0) fail('PDF → latency_ms invalid');
      else if (doc?.chunks !== 1) fail(`PDF → chunks should be 1`);
      else if (doc?.mimeType !== 'application/pdf') fail(`PDF → mimeType mismatch`);
      else if (doc?.filename !== 'test.pdf') fail(`PDF → filename mismatch`);
      else pass(`PDF embed → dims=${embeddings[0].dimensions}`);
    }
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: pdfBase64, filename: 'my file (v2).pdf' } }, 'bearer');
    const data = await res.json() as ApiResponse;
    const doc = data.document;
    if (res.ok && typeof doc?.filename === 'string' && !doc.filename.includes(' ') && !doc.filename.includes('(')) pass(`PDF filename sanitised`);
    else fail('PDF filename sanitisation', data);
  }

  {
    const res = await post('/embeddings/doc', { input: { mimeType: 'application/pdf', data: pdfBase64 } }, 'bearer');
    const data = await res.json() as ApiResponse;
    if (res.ok && data.document?.filename === 'document.pdf') pass('PDF default filename → document.pdf');
    else fail('PDF default filename', data);
  }
}

async function testAdminRoutes() {
  console.log('\n[admin]');

  {
    const res = await fetch(`${API_URL}/admin/tenant?id=${TENANT_ID}`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
    const data = await res.json() as ApiResponse;
    if (res.ok && data.tenant_id === TENANT_ID) pass('GET /admin/tenant → found');
    else fail('GET /admin/tenant', data);
  }

  {
    const res = await fetch(`${API_URL}/admin/tenant?id=nonexistent-tenant-xyz`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
    if (res.status === 404) pass('GET /admin/tenant (nonexistent) → 404');
    else fail('GET /admin/tenant (nonexistent) should be 404', await res.json());
  }

  {
    const res = await fetch(`${API_URL}/admin/tenants`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
    const data = await res.json() as ApiResponse;
    if (res.ok && Array.isArray(data.tenants) && typeof data.count === 'number') pass('GET /admin/tenants → list with count');
    else fail('GET /admin/tenants', data);
  }

  {
    const secondId = `test-tenant-pagination-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await del(`/admin/tenant?id=${secondId}`);
    await post('/admin/tenant', { id: secondId, name: 'Pagination Seed' }, 'admin');
    try {
      const res = await fetch(`${API_URL}/admin/tenants?limit=1`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
      const data = await res.json() as ApiResponse;
      if (res.ok && Array.isArray(data.tenants) && data.tenants.length === 1 && typeof data.next_cursor === 'string') {
        pass('GET /admin/tenants?limit=1 → 1 result + next_cursor');
      } else {
        fail('GET /admin/tenants?limit=1', data);
      }
    } finally {
      await del(`/admin/tenant?id=${secondId}`);
    }
  }

  {
    const res = await post('/admin/tenant', { id: TENANT_ID, name: 'Duplicate' }, 'admin');
    if (res.status === 409) pass('duplicate tenant → 409');
    else fail('duplicate should be 409', await res.json());
  }

  {
    const res = await post('/admin/tenant', { id: 'INVALID ID!', name: 'Bad' }, 'admin');
    if (res.status === 400) pass('invalid tenant ID → 400');
    else fail('invalid tenant ID should be 400', await res.json());
  }

  {
    const res = await fetch(`${API_URL}/admin/tenant`, {
      method: 'PUT',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test', name: 'Test' }),
    });
    if (res.status === 405) pass('PUT /admin/tenant → 405');
    else fail('PUT /admin/tenant should be 405', await res.json());
  }

  {
    const res = await fetch(`${API_URL}/admin/tenants`, { headers: { 'X-Admin-Key': 'wrong-key' } });
    if (res.status === 401) pass('wrong admin key → 401');
    else fail('wrong admin key should be 401', await res.json());
  }

  {
    const res = await del(`/admin/tenant?id=nonexistent-tenant-xyz`);
    if (res.status === 404) pass('DELETE /admin/tenant (nonexistent) → 404');
    else fail('DELETE /admin/tenant (nonexistent) should be 404', await res.json());
  }
}

async function teardown() {
  console.log('\n[cleanup]');
  const res = await del(`/admin/tenant?id=${TENANT_ID}`);
  const data = await res.json() as ApiResponse;
  if (res.ok) pass(`Deleted tenant '${TENANT_ID}'`);
  else fail('DELETE /admin/tenant', data);
}

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
