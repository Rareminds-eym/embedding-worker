/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from './types';
import { AuthError } from './types';

/**
 * Synthetic caller id used for rate-limit bucketing and log correlation on HTTP
 * requests. All authorized HTTP callers share one API key and therefore one
 * bucket. RPC (service-binding) callers use their own constant in entrypoint.ts.
 */
const HTTP_CALLER_ID = 'http';

/**
 * Authenticate an inbound HTTP request against the single shared API key
 * (`env.EMBEDDING_API_KEY`).
 *
 * Every authorized caller (SkillPassport and future internal services) presents
 * the same secret. This mirrors the email-worker auth model. If per-caller
 * isolation is ever needed, introduce a key-to-caller map here.
 *
 * Accepted headers, in priority order:
 *   1. `X-Internal-Api-Key: <key>`   (preferred — signals internal service caller)
 *   2. `X-API-Key: <key>`            (backward-compatible fallback)
 *   3. `Authorization: Bearer <key>` (RFC 6750 fallback)
 *
 * Security: both the supplied key and the secret are hashed to fixed-length
 * SHA-256 digests and compared with `crypto.subtle.timingSafeEqual`. Hashing
 * first yields constant-length inputs, eliminating the length side-channel that
 * a raw comparison would leak over network round-trip timing.
 *
 * @throws {AuthError} (401) when the key is missing or does not match.
 */
export async function authenticate(request: Request, env: Env, requestId: string): Promise<RequestContext> {
  const apiKey =
    request.headers.get('X-Internal-Api-Key') ||
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    throw new AuthError('Missing API key', 'UNAUTHORIZED');
  }

  const enc = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(apiKey)),
    crypto.subtle.digest('SHA-256', enc.encode(env.EMBEDDING_API_KEY)),
  ]);

  if (!crypto.subtle.timingSafeEqual(suppliedHash, expectedHash)) {
    throw new AuthError('Invalid API key', 'UNAUTHORIZED');
  }

  return {
    callerId: HTTP_CALLER_ID,
    requestId,
    startTime: Date.now(),
  };
}
