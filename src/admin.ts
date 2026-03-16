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

  const tenantId = body.id.toLowerCase().replace(/[^a-z0-9-]/g, '-');

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
  const raw_id = new URL(request.url).searchParams.get('id');
  if (!raw_id) throw new ValidationError('Missing query param: id', ERROR_CODES.INVALID_INPUT);
  const id = raw_id.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const raw = await env.EMBEDDING_KV.get(`tenant:${id}`);
  if (!raw) throw new WorkerError(`Tenant '${id}' not found`, ERROR_CODES.NOT_FOUND, 404);

  const tenant: TenantConfig = JSON.parse(raw);
  return jsonOk({ success: true, tenant_id: id, config: tenant }, 200, request, env);
}

// GET /admin/tenants
async function listTenants(request: Request, env: Env): Promise<Response> {
  const list = await env.EMBEDDING_KV.list({ prefix: 'tenant:' });

  const tenants = await Promise.all(
    list.keys.map(async ({ name }) => {
      const raw = await env.EMBEDDING_KV.get(name);
      if (!raw) return null;
      const config: TenantConfig = JSON.parse(raw);
      return {
        tenant_id: name.replace('tenant:', ''),
        name: config.name,
        created_at: config.created_at,
      };
    })
  );

  const filtered = tenants.filter(Boolean);
  return jsonOk({ success: true, tenants: filtered, total: filtered.length }, 200, request, env);
}

// DELETE /admin/tenant?id=xxx
async function deleteTenant(request: Request, env: Env): Promise<Response> {
  const raw_id = new URL(request.url).searchParams.get('id');
  if (!raw_id) throw new ValidationError('Missing query param: id', ERROR_CODES.INVALID_INPUT);
  const id = raw_id.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const existing = await env.EMBEDDING_KV.get(`tenant:${id}`);
  if (!existing) throw new WorkerError(`Tenant '${id}' not found`, ERROR_CODES.NOT_FOUND, 404);

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
