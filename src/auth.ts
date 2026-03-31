/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, TenantConfig, ApiKeyRecord } from './types';
import { AuthError } from './types';
import { sha256 } from './utils/hash';
// Bearer sk_<48 lowercase hex chars>
const TOKEN_REGEX = /^sk_[a-f0-9]{48}$/;

async function safeEqualSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(aHash), new Uint8Array(bHash));
}

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
  const adminKey = env.ADMIN_KEY ?? '';

  if (key.length === 0 || key.length > 512 || adminKey.length === 0) {
    throw new AuthError('Invalid or missing admin key', 'UNAUTHORIZED');
  }

  const match = await safeEqualSecret(key, adminKey);
  if (!match) {
    throw new AuthError('Invalid or missing admin key', 'UNAUTHORIZED');
  }
}
