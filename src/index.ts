/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { authenticate, authenticateAdmin } from './auth';
import { handleTextEmbed } from './handlers/text';
import { handleImageEmbed } from './handlers/image';
import { handleDocEmbed } from './handlers/doc';
import { handleAdmin } from './admin';
import { generateRequestId, getCorsHeaders, jsonOk, jsonError, handleError, validateCorsOrigins } from './utils/response';
import { API_VERSION, ERROR_CODES } from './constants';

function runStartupValidation(env: Env): string | null {
  if (env.ALLOWED_ORIGINS) {
    try {
      validateCorsOrigins(env.ALLOWED_ORIGINS);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) {
    return 'ADMIN_KEY is missing or too weak (min 32 chars)';
  }

  if (env.ENVIRONMENT !== 'local' && !env.RATE_LIMITER) {
    return 'RATE_LIMITER binding is required in non-local environments';
  }

  return null;
}

// Cache the startup validation result for the lifetime of this isolate.
// Workers reuse isolates across requests, so this runs at most once per cold start.
// The env bindings and secrets are immutable within an isolate — caching is safe.
let _cachedConfigError: string | null | undefined = undefined;
function getCachedConfigError(env: Env): string | null {
  if (_cachedConfigError !== undefined) return _cachedConfigError;
  _cachedConfigError = runStartupValidation(env);
  return _cachedConfigError;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Accept a client-supplied request ID only if it passes strict validation.
    // The value is regex-gated before use, so it is safe to echo in logs and
    // response headers. Always generate a fresh UUID if the header is absent or invalid.
    const clientId = request.headers.get('X-Request-ID');
    const requestId = (clientId && /^[a-zA-Z0-9_-]{1,64}$/.test(clientId))
      ? clientId
      : generateRequestId();

    if (env.EMBEDDING_KV === undefined) {
      console.error(JSON.stringify({ event: 'startup.misconfigured', reason: 'EMBEDDING_KV binding missing', request_id: requestId }));
      return jsonError('Service misconfigured', 503, ERROR_CODES.INTERNAL_ERROR, requestId, request, undefined, env);
    }

    const configError = getCachedConfigError(env);
    if (configError) {
      console.error(JSON.stringify({ event: 'startup.misconfigured', reason: configError, request_id: requestId }));
      return jsonError('Service misconfigured', 503, ERROR_CODES.INTERNAL_ERROR, requestId, request, undefined, env);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/health' && request.method === 'GET') {
        const kvHealthy = await env.EMBEDDING_KV.get('health:check').then(() => true).catch(() => false);
        return jsonOk({
          status: kvHealthy ? 'ok' : 'degraded',
          version: API_VERSION,
          timestamp: new Date().toISOString(),
          checks: { kv: kvHealthy },
        }, kvHealthy ? 200 : 503, request, env);
      }

      if (pathname.startsWith('/admin/')) {
        await authenticateAdmin(request, env);
        return await handleAdmin(request, env);
      }

      if (pathname.startsWith('/embeddings/')) {
        if (!env.GEMINI_API_KEY) {
          console.error(JSON.stringify({ event: 'misconfigured', reason: 'GEMINI_API_KEY not set', request_id: requestId }));
          return jsonError('Service misconfigured', 503, ERROR_CODES.INTERNAL_ERROR, requestId, request, undefined, env);
        }

        if (request.method === 'POST') {
          const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
          if (mediaType !== 'application/json') {
            return jsonError('Content-Type must be application/json', 415, ERROR_CODES.INVALID_INPUT, requestId, request, undefined, env);
          }
        }
        const ctx = await authenticate(request, env, requestId);

        if (pathname === '/embeddings/text' && request.method === 'POST') {
          return await handleTextEmbed(request, ctx, env);
        }
        if (pathname === '/embeddings/image' && request.method === 'POST') {
          return await handleImageEmbed(request, ctx, env);
        }
        if (pathname === '/embeddings/doc' && request.method === 'POST') {
          return await handleDocEmbed(request, ctx, env);
        }

        return jsonError('Route not found', 404, ERROR_CODES.NOT_FOUND, requestId, request, undefined, env);
      }

      return jsonError('Not found', 404, ERROR_CODES.NOT_FOUND, requestId, request, undefined, env);

    } catch (err) {
      return handleError(err, requestId, request, env);
    }
  },
} satisfies ExportedHandler<Env>;
