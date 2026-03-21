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
    await env.EMBEDDING_KV.put(`tenant_keys:${tenantId}:${hash}`, '1');
    await env.EMBEDDING_KV.put(`api_keys:${hash}`, JSON.stringify(keyRecord));
    await env.EMBEDDING_KV.put(`tenant:${tenantId}`, JSON.stringify(tenant), {
      metadata: { name: tenant.name, created_at: tenant.created_at },
    });
  } catch (err) {
    // Best-effort cleanup of partial writes
    await Promise.allSettled([
      env.EMBEDDING_KV.delete(`tenant_keys:${tenantId}:${hash}`),
      env.EMBEDDING_KV.delete(`api_keys:${hash}`),
    ]);
    throw err;
  } finally {
    await env.EMBEDDING_KV.delete(lockKey).catch(() => {});
  }

  return jsonOk({
    success: true,
    tenant_id: tenantId,
    api_key: token,
    created_at: tenant.created_at,
  }, 201, request, env);
}

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

async function listTenants(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const cursorParam = url.searchParams.get('cursor') ?? undefined;

  const parsedLimit = limitParam === null ? NaN : parseInt(limitParam, 10);
  const pageSize = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100);

  const page = await env.EMBEDDING_KV.list<{ name: string; created_at: string }>({
    prefix: 'tenant:',
    limit: pageSize,
    cursor: cursorParam,
  });
  const nextCursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;

  // Batch-fetch any keys missing metadata to avoid N+1 serial KV reads.
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
    if (!raw) continue;
    try {
      const config = JSON.parse(raw) as { name: string; created_at: string };
      tenants.push({ tenant_id: k.name.replace('tenant:', ''), name: config.name, created_at: config.created_at });
    } catch {
      console.error(JSON.stringify({ event: 'admin.corrupt_tenant_record', tenant_id: k.name.replace('tenant:', '') }));
    }
  }
  // Restore original key order (withMeta first, then withoutMeta — sort by original index)
  const keyOrder = new Map(page.keys.map((k, i) => [k.name, i]));
  tenants.sort((a, b) => (keyOrder.get(`tenant:${a.tenant_id}`) ?? 0) - (keyOrder.get(`tenant:${b.tenant_id}`) ?? 0));

  return jsonOk({
    success: true,
    tenants,
    count: tenants.length,
    ...(nextCursor && { next_cursor: nextCursor }),
  }, 200, request, env);
}

async function deleteTenant(request: Request, env: Env): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) throw new ValidationError('Missing query param: id', ERROR_CODES.INVALID_INPUT);
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(id)) {
    throw new ValidationError('id must be lowercase alphanumeric with hyphens, 2–64 chars', ERROR_CODES.INVALID_INPUT);
  }

  const existing = await env.EMBEDDING_KV.get(`tenant:${id}`);
  if (!existing) throw new WorkerError(`Tenant '${id}' not found`, ERROR_CODES.NOT_FOUND, 404);

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

  // Legacy full-scan removed: tenant_keys: reverse index above handles all key cleanup.
  // If pre-index keys exist, run DELETE /admin/tenant?id=<id>&legacy_cleanup=true once.
  const legacyCleanup = new URL(request.url).searchParams.get('legacy_cleanup') === 'true';
  if (legacyCleanup) {
    // Audit log: this triggers an O(n) full api_keys: scan — visible in production observability.
    console.warn(JSON.stringify({ event: 'admin.legacy_cleanup_triggered', tenant_id: id }));
    let legacyCursor: string | undefined;
    const legacyDeletes: Promise<void>[] = [];
    do {
      const page = await env.EMBEDDING_KV.list({ prefix: 'api_keys:', limit: 100, cursor: legacyCursor });
      const reads = await Promise.all(page.keys.map(k => env.EMBEDDING_KV.get(k.name).then(raw => ({ k, raw }))));
      for (const { k, raw } of reads) {
        if (raw) {
          try {
            const rec: ApiKeyRecord = JSON.parse(raw);
            if (rec.tenant_id === id) {
              console.error(JSON.stringify({ event: 'admin.legacy_key_cleanup', tenant_id: id, key: k.name }));
              legacyDeletes.push(env.EMBEDDING_KV.delete(k.name));
            }
          } catch { /* skip corrupt records */ }
        }
      }
      legacyCursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
    } while (legacyCursor);
    await Promise.all(legacyDeletes);
  }

  await env.EMBEDDING_KV.delete(`tenant:${id}`);

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
