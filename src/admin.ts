/// <reference types="@cloudflare/workers-types" />

import type { Env, TenantConfig, ApiKeyRecord } from './types';
import { ValidationError, WorkerError } from './types';
import { sha256 } from './utils/hash';
import { jsonOk } from './utils/response';
import { ERROR_CODES } from './constants';

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
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
    throw new WorkerError(`Tenant '${tenantId}' already exists`, 'TENANT_EXISTS', 409);
  }

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

  await env.EMBEDDING_KV.put(`api_keys:${hash}`, JSON.stringify(keyRecord));
  await env.EMBEDDING_KV.put(`tenant:${tenantId}`, JSON.stringify(tenant));

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

  const tenant: TenantConfig = JSON.parse(raw);
  return jsonOk({ success: true, tenant_id: id, config: tenant }, 200, request, env);
}

// GET /admin/tenants
async function listTenants(request: Request, env: Env): Promise<Response> {
  // Paginate through all keys to avoid silent truncation at 1000
  let cursor: string | undefined;
  const allKeys: string[] = [];
  do {
    const page = await env.EMBEDDING_KV.list({ prefix: 'tenant:', limit: 100, cursor });
    allKeys.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);

  // Fetch values in batches of 100 to stay within subrequest budget
  const tenants: { tenant_id: string; name: string; created_at: string }[] = [];
  for (let i = 0; i < allKeys.length; i += 100) {
    const batch = allKeys.slice(i, i + 100);
    const values = await Promise.all(batch.map(name => env.EMBEDDING_KV.get(name)));
    for (let j = 0; j < batch.length; j++) {
      const raw = values[j];
      if (!raw) continue;
      const config: TenantConfig = JSON.parse(raw);
      tenants.push({
        tenant_id: batch[j].replace('tenant:', ''),
        name: config.name,
        created_at: config.created_at,
      });
    }
  }

  return jsonOk({ success: true, tenants, total: tenants.length }, 200, request, env);
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

  // Remove all API keys belonging to this tenant before deleting the tenant record
  let cursor: string | undefined;
  const keyNames: string[] = [];
  do {
    const page = await env.EMBEDDING_KV.list({ prefix: 'api_keys:', limit: 100, cursor });
    keyNames.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
  } while (cursor);

  await Promise.all(keyNames.map(async name => {
    const raw = await env.EMBEDDING_KV.get(name);
    if (raw) {
      const rec: ApiKeyRecord = JSON.parse(raw);
      if (rec.tenant_id === id) await env.EMBEDDING_KV.delete(name);
    }
  }));

  await env.EMBEDDING_KV.delete(`tenant:${id}`);
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
    throw new WorkerError('Method not allowed', 'METHOD_NOT_ALLOWED', 405);
  }

  if (pathname === '/admin/tenants' && method === 'GET') {
    return listTenants(request, env);
  }

  throw new WorkerError('Admin route not found', ERROR_CODES.NOT_FOUND, 404);
}
