/// <reference types="@cloudflare/workers-types" />

import type { Env } from './types';
import { authenticate, authenticateAdmin } from './auth';
import { handleTextEmbed } from './handlers/text';
import { handleImageEmbed } from './handlers/image';
import { handleDocEmbed } from './handlers/doc';
import { handleAdmin } from './admin';
import { generateRequestId, getCorsHeaders, jsonOk, jsonError, handleError } from './utils/response';
import { API_VERSION, MAX_REQUEST_BODY_SIZE, MAX_DOC_REQUEST_BODY_SIZE, MAX_IMAGE_REQUEST_BODY_SIZE, ERROR_CODES } from './constants';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const clientId = request.headers.get('X-Request-ID');
    const requestId = (clientId && /^[a-zA-Z0-9_-]{1,64}$/.test(clientId))
      ? clientId
      : generateRequestId();

    // Fail loudly if KV binding is missing or placeholder IDs were not replaced before deployment
    if (env.EMBEDDING_KV === undefined) {
      console.error(JSON.stringify({ event: 'startup.misconfigured', reason: 'EMBEDDING_KV binding missing', request_id: requestId }));
      return jsonError('Service misconfigured', 503, ERROR_CODES.INTERNAL_ERROR, requestId, request, undefined, env);
    }
    // KVNamespace exposes the namespace ID at runtime — catch unreplaced wrangler.toml placeholders
    const kvId = (env.EMBEDDING_KV as unknown as { id?: string }).id ?? '';
    if (kvId.startsWith('REPLACE_WITH')) {
      console.error(JSON.stringify({ event: 'startup.misconfigured', reason: 'KV namespace ID not replaced in wrangler.toml', id: kvId, request_id: requestId }));
      return jsonError('Service misconfigured', 503, ERROR_CODES.INTERNAL_ERROR, requestId, request, undefined, env);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    const contentLength = request.headers.get('Content-Length');
    const { pathname } = new URL(request.url);
    const routeLimit = pathname === '/embeddings/doc'
      ? MAX_DOC_REQUEST_BODY_SIZE
      : pathname === '/embeddings/image'
        ? MAX_IMAGE_REQUEST_BODY_SIZE
        : MAX_REQUEST_BODY_SIZE;

    if (contentLength) {
      if (!/^\d+$/.test(contentLength)) {
        return jsonError('Invalid Content-Length header', 400, ERROR_CODES.INVALID_INPUT, requestId, request, undefined, env);
      }
      if (Number(contentLength) > routeLimit) {
        return jsonError('Request body too large', 413, ERROR_CODES.INVALID_INPUT, requestId, request, undefined, env);
      }
    }
    // Note: chunked transfer (no Content-Length) bypasses the header check above.
    // Each handler enforces its own body size limit after request.text().

    try {
      if (pathname === '/health' && request.method === 'GET') {
        return jsonOk({
          status: 'ok',
          version: API_VERSION,
          timestamp: new Date().toISOString(),
        }, 200, request, env);
      }

      if (pathname.startsWith('/admin/')) {
        await authenticateAdmin(request, env);
        return await handleAdmin(request, env);
      }

      if (pathname.startsWith('/embeddings/')) {
        if (request.method === 'POST') {
          const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
          if (mediaType !== 'application/json') {
            return jsonError('Content-Type must be application/json', 415, ERROR_CODES.INVALID_INPUT, requestId, request, undefined, env);
          }
        }
        // Check required secrets here — /health must not depend on secret availability
        if (!env.VOYAGE_API_KEY) {
          console.error(JSON.stringify({ event: 'misconfigured', reason: 'VOYAGE_API_KEY not set' }));
          return jsonError('Service misconfigured', 503, ERROR_CODES.INTERNAL_ERROR, requestId, request, undefined, env);
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
