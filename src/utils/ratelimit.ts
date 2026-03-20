/// <reference types="@cloudflare/workers-types" />

import type { Env } from '../types';
import { RateLimitError } from '../types';
import { RATE_LIMIT_WINDOW_SECONDS, RATE_LIMITS } from '../constants';

export async function checkRateLimit(
  tenantId: string,
  endpoint: string,
  env: Env,
): Promise<void> {
  const limit = RATE_LIMITS[endpoint as 'text' | 'image' | 'doc'];
  if (!limit) return;

  const window = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `rl:${tenantId}:${endpoint}:${window}`;

  // NOTE: Non-atomic read-modify-write. Cloudflare KV does not support atomic
  // increments. Under concurrent load for the same tenant/endpoint/window, two
  // requests can both read the same count and both write count+1, meaning the
  // effective limit may be exceeded by the degree of concurrency. This is an
  // accepted trade-off given KV's consistency model. For strict enforcement,
  // migrate this to a Durable Object with an in-memory counter.
  const raw = await env.EMBEDDING_KV.get(key);
  const parsed = raw ? parseInt(raw, 10) : 0;
  const count = Number.isFinite(parsed) ? parsed : 0;

  if (count >= limit) {
    const windowResetSeconds = RATE_LIMIT_WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % RATE_LIMIT_WINDOW_SECONDS);
    console.error(JSON.stringify({ event: 'rate_limit.exceeded', tenant_id: tenantId, endpoint, count, limit, retry_after: windowResetSeconds }));
    throw new RateLimitError(
      `Rate limit exceeded: ${limit} requests per ${RATE_LIMIT_WINDOW_SECONDS}s on /${endpoint}. Retry after ${windowResetSeconds}s.`,
      windowResetSeconds,
    );
  }

  await env.EMBEDDING_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
}
