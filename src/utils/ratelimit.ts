/// <reference types="@cloudflare/workers-types" />

import type { Env } from '../types';
import { RateLimitError } from '../types';
import { RATE_LIMIT_WINDOW_SECONDS, RATE_LIMITS } from '../constants';

export async function checkRateLimit(
  tenantId: string,
  endpoint: keyof typeof RATE_LIMITS,
  env: Env,
): Promise<void> {
  const limit = RATE_LIMITS[endpoint];
  if (limit === undefined) return;

  const window = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const key = `rl:${tenantId}:${endpoint}:${window}`;

  // NOTE: Non-atomic read-modify-write. Cloudflare KV does not support atomic
  // increments. Under concurrent load for the same tenant/endpoint/window, two
  // requests can both read the same count and both write count+1, meaning the
  // effective limit may be exceeded by the degree of concurrency. Additionally,
  // KV enforces a ~1 write/sec per-key limit — the text endpoint (120 req/min)
  // can exceed this under sustained load, causing put() errors. This is an
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

  const safetyMargin = Math.min(5, Math.ceil(limit * 0.1));
  if (count >= limit - safetyMargin) {
    console.warn(JSON.stringify({ event: 'rate_limit.approaching_threshold', tenant_id: tenantId, endpoint, count, limit }));
  }

  // KV write failure is non-fatal — rate limit check already passed, don't block the request.
  // Cap at limit + 10 to prevent unbounded counter growth under concurrent write races
  // (KV non-atomic read-modify-write means concurrent requests can each increment by 1,
  // so the effective count may slightly exceed `limit` — this is an accepted trade-off).
  try {
    const safeCount = Math.min(count + 1, limit + 10);
    await env.EMBEDDING_KV.put(key, String(safeCount), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
  } catch (err) {
    console.error(JSON.stringify({ event: 'rate_limit.kv_write_failed', tenant_id: tenantId, endpoint, error: err instanceof Error ? err.message : String(err) }));
  }
}
