/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, TenantConfig, ApiKeyRecord } from './types';
import { AuthError } from './types';
import { sha256 } from './utils/hash';
// Bearer sk_<48 lowercase hex chars>
const TOKEN_REGEX = /^sk_[a-f0-9]{48}$/;

export async function authenticate(request: Request, env: Env, requestId: string): Promise<RequestContext> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header', 'UNAUTHORIZED');
  }

  const token = authHeader.slice(7).trim();
  if (!TOKEN_REGEX.test(token)) {
    throw new AuthError('Invalid API key format', 'UNAUTHORIZED');
  }

  const hash = await sha256(token);
  const keyRaw = await env.EMBEDDING_KV.get(`api_keys:${hash}`);
  if (!keyRaw) {
    throw new AuthError('Invalid API key', 'UNAUTHORIZED');
  }

  const keyRecord: ApiKeyRecord = JSON.parse(keyRaw);
  const tenantRaw = await env.EMBEDDING_KV.get(`tenant:${keyRecord.tenant_id}`);
  if (!tenantRaw) {
    throw new AuthError('Tenant not found', 'UNAUTHORIZED');
  }

  const tenant: TenantConfig = JSON.parse(tenantRaw);

  return {
    tenantId: keyRecord.tenant_id,
    tenant,
    requestId,
    startTime: Date.now(),
  };
}

export async function authenticateAdmin(request: Request, env: Env): Promise<void> {
  const key = request.headers.get('X-Admin-Key') ?? '';
  const enc = new TextEncoder();
  const a = enc.encode(key.padEnd(64));
  const b = enc.encode((env.ADMIN_KEY ?? '').padEnd(64));
  const match = await crypto.subtle.timingSafeEqual(a, b);
  if (!match || key.length === 0) {
    throw new AuthError('Invalid or missing admin key', 'UNAUTHORIZED');
  }
}
