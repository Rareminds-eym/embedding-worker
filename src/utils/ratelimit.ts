/// <reference types="@cloudflare/workers-types" />

import type { Env } from '../types';
import { RateLimitError } from '../types';
import { RATE_LIMIT_WINDOW_SECONDS, RATE_LIMITS } from '../constants';

/**
 * KV-based sliding window rate limiter.
 * Key: rl:<tenantId>:<endpoint>:<window>
 * Value: request count as string
 *
 * Note: KV is eventually consistent — concurrent requests may read stale counts.
 * This is acceptable for quota protection (catches runaway tenants) but not a
 * hard security boundary. Use Durable Objects if strict enforcement is needed.
 */
export async function checkRateLimit(
  tenantId: string,
  endpoint: string,
  env: Env,
): Promise<void> {
  const limit = RATE_LIMITS[endpoint as 'text' | 'image' | 'doc'];
  if (!limit) return; // no limit configured for this endpoint

  const window = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `rl:${tenantId}:${endpoint}:${window}`;

  const raw = await env.EMBEDDING_KV.get(key);
  const parsed = raw ? parseInt(raw, 10) : 0;
  // Guard against corrupted KV values — NaN >= limit is false, which would silently bypass the limit
  const count = Number.isFinite(parsed) ? parsed : 0;

  if (count >= limit) {
    const windowResetSeconds = RATE_LIMIT_WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % RATE_LIMIT_WINDOW_SECONDS);
    console.error(JSON.stringify({ event: 'rate_limit.exceeded', tenant_id: tenantId, endpoint, count, limit, retry_after: windowResetSeconds }));
    throw new RateLimitError(
      `Rate limit exceeded: ${limit} requests per ${RATE_LIMIT_WINDOW_SECONDS}s on /${endpoint}. Retry after ${windowResetSeconds}s.`,
      windowResetSeconds,
    );
  }

  // Increment — TTL slightly longer than window to ensure key expires cleanly
  await env.EMBEDDING_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
}
