/// <reference types="@cloudflare/workers-types" />

import { CORS_MAX_AGE, ERROR_CODES } from '../constants';
import type { Env } from '../types';
import { AuthError, ValidationError, ProviderError, RateLimitError, WorkerError } from '../types';

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export function getCorsHeaders(request: Request, env?: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowedOrigins = env?.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': String(CORS_MAX_AGE),
    'Cache-Control': 'no-store',
  };
  if (origin) {
    // Only set Vary: Origin when the request actually has an Origin header.
    // Setting it unconditionally causes CDN/proxy cache fragmentation on non-browser traffic.
    headers['Vary'] = 'Origin';
  }
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function jsonOk(data: unknown, status = 200, request?: Request, env?: Env, requestId?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (request) Object.assign(headers, getCorsHeaders(request, env));
  if (requestId) headers['X-Request-ID'] = requestId;
  return new Response(JSON.stringify(data), { status, headers });
}

export function jsonError(
  message: string,
  status: number,
  code: string,
  requestId: string,
  request?: Request,
  extra?: Record<string, unknown>,
  env?: Env
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Request-ID': requestId };
  if (request) Object.assign(headers, getCorsHeaders(request, env));
  return new Response(
    JSON.stringify({ success: false, errorCode: code, message, request_id: requestId, ...extra }),
    { status, headers }
  );
}

export function handleError(err: unknown, requestId: string, request?: Request, env?: Env): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Request-ID': requestId };
  if (request) Object.assign(headers, getCorsHeaders(request, env));

  if (err instanceof AuthError) {
    return new Response(
      JSON.stringify({ success: false, errorCode: err.code, message: err.message, request_id: requestId }),
      { status: 401, headers }
    );
  }
  if (err instanceof ValidationError) {
    return new Response(
      JSON.stringify({ success: false, errorCode: err.code, message: err.message, request_id: requestId }),
      { status: 400, headers }
    );
  }
  if (err instanceof RateLimitError) {
    const extra: Record<string, unknown> = {};
    if (err.retryAfterSeconds !== undefined) {
      extra['retry_after_seconds'] = err.retryAfterSeconds;
      headers['Retry-After'] = String(err.retryAfterSeconds);
    }
    return new Response(
      JSON.stringify({ success: false, errorCode: ERROR_CODES.RATE_LIMIT_EXCEEDED, message: err.message, request_id: requestId, ...extra }),
      { status: 429, headers }
    );
  }
  if (err instanceof ProviderError) {
    // Always map to 502 for non-429 errors — forwarding upstream 4xx (e.g. 401, 403)
    // would mislead clients into thinking their own credentials are invalid.
    const status = err.status === 429 ? 429 : 502;
    const errorCode = err.status === 429 ? ERROR_CODES.RATE_LIMIT_EXCEEDED : ERROR_CODES.PROVIDER_ERROR;
    if (err.status === 429) headers['Retry-After'] = '60';
    return new Response(
      JSON.stringify({ success: false, errorCode, message: err.message, request_id: requestId }),
      { status, headers }
    );
  }
  if (err instanceof WorkerError) {
    return new Response(
      JSON.stringify({ success: false, errorCode: err.code, message: err.message, request_id: requestId }),
      { status: err.status, headers }
    );
  }

  if (err instanceof Error) {
    console.error(JSON.stringify({ event: 'unhandled_error', request_id: requestId, message: err.message, stack: err.stack }));
  }
  return new Response(
    JSON.stringify({ success: false, errorCode: ERROR_CODES.INTERNAL_ERROR, message: 'Internal server error', request_id: requestId }),
    { status: 500, headers }
  );
}
