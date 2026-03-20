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

// POST /admin/tenant
async function createTenant(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as {
    id?: string;
    name?: string;
  } | null;

  if (!body?.id) throw new ValidationError('Missing required field: id', ERROR_CODES.INVALID_INPUT);
  if (!body?.name) throw new ValidationError('Missing required field: name', ERROR_CODES.INVALID_INPUT);

  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(body.id)) {
    throw new ValidationError('id must be lowercase alphanumeric with hyphens, 2–64 chars, and cannot start or end with a hyphen', ERROR_CODES.INVALID_INPUT);
  }
  const tenantId = body.id;

  const existing = await env.EMBEDDING_KV.get(`tenant:${tenantId}`);
  if (existing) {
    throw new WorkerError(`Tenant '${tenantId}' already exists`, ERROR_CODES.TENANT_EXISTS, 409);
  }

  // Optimistic lock: write a short-TTL lock key to reduce TOCTOU race window.
  // KV has no atomic CAS, so concurrent requests can still race, but this makes
  // the window small enough to be acceptable for low-frequency admin operations.
  const lockKey = `lock:tenant:${tenantId}`;
  const lockHeld = await env.EMBEDDING_KV.get(lockKey);
  if (lockHeld) {
    throw new WorkerError(`Tenant '${tenantId}' creation already in progress`, ERROR_CODES.TENANT_EXISTS, 409);
  }
  await env.EMBEDDING_KV.put(lockKey, '1', { expirationTtl: 60 });

  const token = generateToken();
  const hash = await sha256(token);

  const tenant: TenantConfig = {
    name: body.name,
    created_at: new Date().toISOString(),
  };

  const keyRecord: ApiKeyRecord = {
    tenant_id: tenantId,
    created_at: new Date().toISOString(),
  };

  try {
    // Write reverse index first — an orphaned index entry is harmless.
    // An orphaned api_keys: entry (written first) would grant auth forever and
    // never be found by deleteTenant's reverse-index scan.
    await env.EMBEDDING_KV.put(`tenant_keys:${tenantId}:${hash}`, '1');
    await env.EMBEDDING_KV.put(`api_keys:${hash}`, JSON.stringify(keyRecord));
    await env.EMBEDDING_KV.put(`tenant:${tenantId}`, JSON.stringify(tenant));
  } finally {
    // Always release the lock — whether the writes succeeded or failed.
    // On failure the caller can retry; on success the lock is no longer needed.
    await env.EMBEDDING_KV.delete(lockKey).catch(() => {});
  }

  return jsonOk({
    success: true,
    tenant_id: tenantId,
    api_key: token,
    created_at: tenant.created_at,
  }, 201, request, env);
}

// GET /admin/tenant?id=xxx
async function getTenant(request: Request, env: Env): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
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
  return jsonOk({ success: true, tenant_id: id, config: tenant }, 200, request, env);
}

// GET /admin/tenants?limit=50&cursor=xxx
async function listTenants(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const cursorParam = url.searchParams.get('cursor') ?? undefined;

  const pageSize = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 100) : 50;

  const page = await env.EMBEDDING_KV.list({ prefix: 'tenant:', limit: pageSize, cursor: cursorParam });
  const nextCursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;

  // pageSize capped at 100 — each key requires one KV.get(), so this consumes up to 100
  // of the 1,000 subrequest budget per Worker invocation. Do not raise the cap without review.
  const values = await Promise.all(page.keys.map(k => env.EMBEDDING_KV.get(k.name)));
  const tenants: { tenant_id: string; name: string; created_at: string }[] = [];
  for (let i = 0; i < page.keys.length; i++) {
    const raw = values[i];
    if (!raw) continue;
    let config: TenantConfig;
    try {
      config = JSON.parse(raw);
    } catch {
      console.error(JSON.stringify({ event: 'admin.corrupt_tenant_record', tenant_id: page.keys[i].name.replace('tenant:', '') }));
      continue; // skip corrupt records, don't crash the list
    }
    tenants.push({
      tenant_id: page.keys[i].name.replace('tenant:', ''),
      name: config.name,
      created_at: config.created_at,
    });
  }

  return jsonOk({
    success: true,
    tenants,
    count: tenants.length,
    ...(nextCursor && { next_cursor: nextCursor }),
  }, 200, request, env);
}

// DELETE /admin/tenant?id=xxx
async function deleteTenant(request: Request, env: Env): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) throw new ValidationError('Missing query param: id', ERROR_CODES.INVALID_INPUT);
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(id)) {
    throw new ValidationError('id must be lowercase alphanumeric with hyphens, 2–64 chars', ERROR_CODES.INVALID_INPUT);
  }

  const existing = await env.EMBEDDING_KV.get(`tenant:${id}`);
  if (!existing) throw new WorkerError(`Tenant '${id}' not found`, ERROR_CODES.NOT_FOUND, 404);

  // Use the reverse index (tenant_keys:<id>:<hash>) to find only this tenant's API keys.
  // This is O(keys per tenant) instead of O(all api_keys:* in the namespace).
  let tkCursor: string | undefined;
  const apiKeyDeletes: Promise<void>[] = [];
  do {
    const page = await env.EMBEDDING_KV.list({ prefix: `tenant_keys:${id}:`, limit: 100, cursor: tkCursor });
    for (const k of page.keys) {
      const hash = k.name.slice(`tenant_keys:${id}:`.length);
      apiKeyDeletes.push(
        env.EMBEDDING_KV.delete(`api_keys:${hash}`),
        env.EMBEDDING_KV.delete(k.name),
      );
    }
    tkCursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (tkCursor);
  await Promise.all(apiKeyDeletes);

  await env.EMBEDDING_KV.delete(`tenant:${id}`);

  // Clean up rate limit keys for this tenant (best-effort, they expire anyway)
  let rlCursor: string | undefined;
  const rlKeys: string[] = [];
  do {
    const page = await env.EMBEDDING_KV.list({ prefix: `rl:${id}:`, limit: 100, cursor: rlCursor });
    rlKeys.push(...page.keys.map(k => k.name));
    rlCursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (rlCursor);
  await Promise.all(rlKeys.map(k => env.EMBEDDING_KV.delete(k)));

  return jsonOk({ success: true, message: `Tenant '${id}' deleted` }, 200, request, env);
}

// ── Admin router ───────────────────────────────────────────
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === '/admin/tenant') {
    if (method === 'POST')   return createTenant(request, env);
    if (method === 'GET')    return getTenant(request, env);
    if (method === 'DELETE') return deleteTenant(request, env);
    throw new WorkerError('Method not allowed', ERROR_CODES.METHOD_NOT_ALLOWED, 405);
  }

  if (pathname === '/admin/tenants' && method === 'GET') {
    return listTenants(request, env);
  }

  throw new WorkerError('Admin route not found', ERROR_CODES.NOT_FOUND, 404);
}
