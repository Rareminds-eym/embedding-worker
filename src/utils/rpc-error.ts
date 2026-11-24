import { ValidationError, RateLimitError, ProviderError, AuthError, WorkerError } from '../types';

/** RPC preserves Error messages, not custom fields. Include validated backoff
 * metadata in the stable transport message so app queues honor provider limits. */
export function toRpcError(err: unknown): Error {
  if (err instanceof ValidationError) return new Error(`INVALID_INPUT: ${err.message}`);
  if (err instanceof RateLimitError) {
    const retryAfter = err.retryAfterSeconds;
    const message = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 86400
      ? `Rate limit exceeded. Retry after ${Math.ceil(retryAfter)}s.`
      : 'Rate limit exceeded. Please wait before retrying.';
    return new Error(`RATE_LIMIT_EXCEEDED: ${message}`);
  }
  if (err instanceof ProviderError) return new Error(`PROVIDER_ERROR: ${err.message}`);
  if (err instanceof AuthError) return new Error(`UNAUTHORIZED: ${err.message}`);
  if (err instanceof WorkerError) return new Error(`${err.code}: ${err.message}`);
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`INTERNAL_ERROR: ${message}`);
}
