/// <reference types="@cloudflare/workers-types" />

import type { Env } from '../types';
import { RateLimitError, WorkerError } from '../types';
import { RATE_LIMIT_WINDOW_SECONDS, RATE_LIMITS, ERROR_CODES } from '../constants';

export async function checkRateLimit(
  tenantId: string,
  endpoint: keyof typeof RATE_LIMITS,
  env: Env,
): Promise<void> {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: `${tenantId}:${endpoint}` });
    if (!success) {
      console.error(JSON.stringify({ event: 'rate_limit.exceeded', tenant_id: tenantId, endpoint }));
      throw new RateLimitError(
        `Rate limit exceeded on /${endpoint}. Retry after ${RATE_LIMIT_WINDOW_SECONDS}s.`,
        RATE_LIMIT_WINDOW_SECONDS,
      );
    }
    return;
  }

  // KV fallback: non-atomic, local dev only. Not suitable for production.
  if (env.ENVIRONMENT !== 'local') {
    throw new WorkerError('Rate limiter not configured', ERROR_CODES.INTERNAL_ERROR, 503);
  }

  const limit = RATE_LIMITS[endpoint];
  if (limit === undefined) return;

  const window = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `rl:${tenantId}:${endpoint}:${window}`;
  const count = parseInt(await env.EMBEDDING_KV.get(key) ?? '0', 10) || 0;

  if (count >= limit) {
    const retryAfter = RATE_LIMIT_WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % RATE_LIMIT_WINDOW_SECONDS);
    console.error(JSON.stringify({ event: 'rate_limit.exceeded', tenant_id: tenantId, endpoint, count, limit }));
    throw new RateLimitError(
      `Rate limit exceeded: ${limit} requests per ${RATE_LIMIT_WINDOW_SECONDS}s on /${endpoint}. Retry after ${retryAfter}s.`,
      retryAfter,
    );
  }

  try {
    await env.EMBEDDING_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
  } catch (err) {
    console.error(JSON.stringify({ event: 'rate_limit.kv_write_failed', tenant_id: tenantId, endpoint, error: err instanceof Error ? err.message : String(err) }));
  }
}
