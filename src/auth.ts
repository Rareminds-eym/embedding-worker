/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, ApiKeyRecord } from './types';
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

  let keyRecord: ApiKeyRecord;
  try {
    const parsed: unknown = JSON.parse(keyRaw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).tenant_id !== 'string'
    ) {
      throw new Error('invalid key record shape');
    }
    keyRecord = parsed as ApiKeyRecord;
  } catch {
    console.error(JSON.stringify({ event: 'auth.corrupt_key_record', hash }));
    throw new AuthError('Invalid API key', 'UNAUTHORIZED');
  }

  // Verify the tenant record still exists (guards against deleted tenants with live keys)
  const tenantExists = await env.EMBEDDING_KV.get(`tenant:${keyRecord.tenant_id}`, { type: 'text', cacheTtl: 60 });
  if (!tenantExists) {
    throw new AuthError('Tenant not found', 'UNAUTHORIZED');
  }

  return {
    tenantId: keyRecord.tenant_id,
    requestId,
    startTime: Date.now(),
  };
}

export async function authenticateAdmin(request: Request, env: Env): Promise<void> {
  const key = request.headers.get('X-Admin-Key') ?? '';
  const expected = env.ADMIN_KEY ?? '';
  // Fail-closed: reject immediately if either side is empty
  if (key.length === 0 || expected.length === 0) {
    throw new AuthError('Invalid or missing admin key', 'UNAUTHORIZED');
  }
  // Hash both sides with SHA-256 — always 32-byte output, safe for timingSafeEqual.
  // No HMAC key needed: the goal is purely constant-time comparison, not MAC authentication.
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(key)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  if (!(await crypto.subtle.timingSafeEqual(hashA, hashB))) {
    throw new AuthError('Invalid or missing admin key', 'UNAUTHORIZED');
  }
}
