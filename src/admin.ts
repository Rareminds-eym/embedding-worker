/// <reference types="@cloudflare/workers-types" />

import type { Env, TenantConfig, ApiKeyRecord } from './types';
import { ValidationError, WorkerError } from './types';
import { sha256 } from './utils/hash';
import { jsonOk } from './utils/response';
import { ERROR_CODES, API_KEY_BYTE_LENGTH } from './constants';

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(API_KEY_BYTE_LENGTH));
  return `sk_${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

async function createTenant(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ValidationError('Content-Type must be application/json', ERROR_CODES.INVALID_INPUT);
  }

  const bodyText = await request.text().catch(() => '');
  if (bodyText.length > 65_536) {
    throw new ValidationError('Request body too large', ERROR_CODES.INVALID_INPUT);
  }

  const body = (() => { try { return JSON.parse(bodyText) as Record<string, unknown>; } catch { return null; } })();

  if (!body || typeof body.id !== 'string') {
    throw new ValidationError('Missing required field: id', ERROR_CODES.INVALID_INPUT);
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    throw new ValidationError('Missing required field: name', ERROR_CODES.INVALID_INPUT);
  }
  // Trim and cap at 128 chars — KV metadata has a 1024-byte limit and name is
  // stored there. Reject control characters and leading/trailing whitespace.
  const name = body.name.trim().slice(0, 128);
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new ValidationError('name must not contain control characters', ERROR_CODES.INVALID_INPUT);
  }

  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(body.id)) {
    throw new ValidationError('id must be lowercase alphanumeric with hyphens, 2–64 chars, and cannot start or end with a hyphen', ERROR_CODES.INVALID_INPUT);
  }
  const tenantId = body.id;

  const existing = await env.EMBEDDING_KV.get(`tenant:${tenantId}`);
  if (existing) {
    throw new WorkerError(`Tenant '${tenantId}' already exists`, ERROR_CODES.TENANT_EXISTS, 409);
  }

  const token = generateToken();
  const hash = await sha256(token);

  const tenant: TenantConfig = {
    name,
    created_at: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };

  const keyRecord: ApiKeyRecord = {
    tenant_id: tenantId,
    created_at: new Date().toISOString(),
  };

  try {
    await Promise.all([
      env.EMBEDDING_KV.put(`tenant_keys:${tenantId}:${hash}`, '1'),
      env.EMBEDDING_KV.put(`api_keys:${hash}`, JSON.stringify(keyRecord)),
      env.EMBEDDING_KV.put(`tenant:${tenantId}`, JSON.stringify(tenant), {
        metadata: { name: tenant.name, created_at: tenant.created_at },
      }),
    ]);
  } catch (err) {
    await Promise.allSettled([
      env.EMBEDDING_KV.delete(`tenant:${tenantId}`),
      env.EMBEDDING_KV.delete(`api_keys:${hash}`),
      env.EMBEDDING_KV.delete(`tenant_keys:${tenantId}:${hash}`),
    ]);
    throw err;
  }

  // TOCTOU guard: KV has no atomic CAS. Re-read the tenant record and verify it
  // matches what we just wrote using the nonce — a UUID unique to this write.
  // created_at alone is insufficient because two concurrent requests completing
  // within the same millisecond would both pass. The nonce is cryptographically
  // unique, so a mismatch unambiguously means another writer won the race.
  // If we lost: clean up our orphaned api_keys entry and surface a 409.
  const verify = await env.EMBEDDING_KV.get(`tenant:${tenantId}`);
  const verifyParsed = verify ? (() => { try { return JSON.parse(verify) as TenantConfig; } catch { return null; } })() : null;
  if (!verifyParsed || verifyParsed.nonce !== tenant.nonce) {
    await Promise.allSettled([
      env.EMBEDDING_KV.delete(`api_keys:${hash}`),
      env.EMBEDDING_KV.delete(`tenant_keys:${tenantId}:${hash}`),
    ]);
    throw new WorkerError(`Tenant '${tenantId}' already exists`, ERROR_CODES.TENANT_EXISTS, 409);
  }

  return jsonOk({
    success: true,
    tenant_id: tenantId,
    api_key: token,
    warning: 'Save this API key now. It will not be shown again.',
    created_at: tenant.created_at,
  }, 201, request, env);
}

async function getTenant(request: Request, env: Env, url: URL): Promise<Response> {
  const id = url.searchParams.get('id');
  if (!id) throw new ValidationError('Missing query param: id', ERROR_CODES.INVALID_INPUT);
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(id)) {
    throw new ValidationError('id must be lowercase alphanumeric with hyphens, 2–64 chars', ERROR_CODES.INVALID_INPUT);
  }

  const raw = await env.EMBEDDING_KV.get(`tenant:${id}`);
  if (!raw) throw new WorkerError(`Tenant '${id}' not found`, ERROR_CODES.NOT_FOUND, 404);

  let tenant: TenantConfig;
  try {
    tenant = JSON.parse(raw);
  } catch {
    console.error(JSON.stringify({ event: 'admin.corrupt_tenant_record', tenant_id: id }));
    throw new WorkerError(`Tenant '${id}' record is corrupt`, ERROR_CODES.INTERNAL_ERROR, 500);
  }
  return jsonOk({ success: true, tenant_id: id, config: { name: tenant.name, created_at: tenant.created_at } }, 200, request, env);
}

async function listTenants(request: Request, env: Env, url: URL): Promise<Response> {
  const limitParam = url.searchParams.get('limit');
  const cursorParam = url.searchParams.get('cursor') ?? undefined;

  const parsedLimit = limitParam === null ? NaN : parseInt(limitParam, 10);
  const pageSize = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100);

  const page = await env.EMBEDDING_KV.list<{ name: string; created_at: string }>({
    prefix: 'tenant:',
    limit: pageSize,
    cursor: cursorParam,
  });
  const nextCursor = page.list_complete ? undefined : page.cursor;

  const withMeta = page.keys.filter(k => k.metadata?.name && k.metadata?.created_at);
  const withoutMeta = page.keys.filter(k => !k.metadata?.name || !k.metadata?.created_at);
  const fetched = await Promise.all(
    withoutMeta.map(k => env.EMBEDDING_KV.get(k.name).then(raw => ({ k, raw })))
  );

  const tenants: { tenant_id: string; name: string; created_at: string }[] = [];
  for (const key of withMeta) {
    tenants.push({
      tenant_id: key.name.replace('tenant:', ''),
      name: key.metadata!.name,
      created_at: key.metadata!.created_at,
    });
  }
  for (const { k, raw } of fetched) {
    if (!raw) {
      console.error(JSON.stringify({ event: 'admin.tenant_record_missing', tenant_id: k.name.replace('tenant:', '') }));
      continue;
    }
    try {
      const config = JSON.parse(raw) as { name: string; created_at: string };
      tenants.push({ tenant_id: k.name.replace('tenant:', ''), name: config.name, created_at: config.created_at });
    } catch {
      console.error(JSON.stringify({ event: 'admin.corrupt_tenant_record', tenant_id: k.name.replace('tenant:', '') }));
    }
  }
  const keyOrder = new Map(page.keys.map((k, i) => [k.name, i]));
  tenants.sort((a, b) => (keyOrder.get(`tenant:${a.tenant_id}`) ?? 0) - (keyOrder.get(`tenant:${b.tenant_id}`) ?? 0));

  return jsonOk({
    success: true,
    tenants,
    count: tenants.length,
    sort: 'lexicographic',
    ...(nextCursor && { next_cursor: nextCursor }),
  }, 200, request, env);
}

async function deleteTenant(request: Request, env: Env, url: URL): Promise<Response> {
  const id = url.searchParams.get('id');
  if (!id) throw new ValidationError('Missing query param: id', ERROR_CODES.INVALID_INPUT);
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(id)) {
    throw new ValidationError('id must be lowercase alphanumeric with hyphens, 2–64 chars', ERROR_CODES.INVALID_INPUT);
  }

  const existing = await env.EMBEDDING_KV.get(`tenant:${id}`);
  if (!existing) throw new WorkerError(`Tenant '${id}' not found`, ERROR_CODES.NOT_FOUND, 404);

  const deletionInProgress = await env.EMBEDDING_KV.get(`delete:tenant:${id}`);
  if (deletionInProgress) {
    throw new WorkerError(`Tenant '${id}' deletion already in progress`, ERROR_CODES.INTERNAL_ERROR, 409);
  }

  // Set deletion flag first — auth checks this and blocks the tenant immediately.
  // TTL is intentionally long: if the worker dies mid-deletion, the flag keeps
  // the tenant blocked until a retry or manual cleanup completes.
  await env.EMBEDDING_KV.put(`delete:tenant:${id}`, JSON.stringify({ started_at: new Date().toISOString() }), { expirationTtl: 86_400 });

  let tkCursor: string | undefined;
  let totalDeleted = 0;

  do {
    const page = await env.EMBEDDING_KV.list({ prefix: `tenant_keys:${id}:`, limit: 100, cursor: tkCursor });
    await Promise.all(page.keys.flatMap(k => {
      const hash = k.name.slice(`tenant_keys:${id}:`.length);
      return [
        env.EMBEDDING_KV.delete(`api_keys:${hash}`),
        env.EMBEDDING_KV.delete(k.name),
      ];
    }));
    totalDeleted += page.keys.length;
    tkCursor = page.list_complete ? undefined : page.cursor;
  } while (tkCursor);

  await env.EMBEDDING_KV.delete(`tenant:${id}`);

  // Clean up rate-limit counters (best-effort, non-critical).
  let rlCursor: string | undefined;
  do {
    const page = await env.EMBEDDING_KV.list({ prefix: `rl:${id}:`, limit: 100, cursor: rlCursor });
    await Promise.all(page.keys.map(k => env.EMBEDDING_KV.delete(k.name)));
    rlCursor = page.list_complete ? undefined : page.cursor;
  } while (rlCursor);

  // Only remove the deletion flag once all keys are gone.
  // If the worker was killed before this point, the flag remains and auth stays blocked.
  await env.EMBEDDING_KV.delete(`delete:tenant:${id}`);

  console.log(JSON.stringify({ event: 'tenant.deleted', tenant_id: id, keys_deleted: totalDeleted }));

  return jsonOk({ success: true, message: `Tenant '${id}' deleted` }, 200, request, env);
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/admin/tenant') {
    if (method === 'POST')   return createTenant(request, env);
    if (method === 'GET')    return getTenant(request, env, url);
    if (method === 'DELETE') return deleteTenant(request, env, url);
    throw new WorkerError('Method not allowed', ERROR_CODES.METHOD_NOT_ALLOWED, 405);
  }

  if (pathname === '/admin/tenants' && method === 'GET') {
    return listTenants(request, env, url);
  }

  throw new WorkerError('Admin route not found', ERROR_CODES.NOT_FOUND, 404);
}
