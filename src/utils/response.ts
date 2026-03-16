/// <reference types="@cloudflare/workers-types" />

import { CORS_MAX_AGE, ERROR_CODES } from '../constants';
import type { Env } from '../types';
import { AuthError, ValidationError, RateLimitError, ProviderError, WorkerError } from '../types';

export function generateRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `req_${Date.now().toString(36)}_${hex}`;
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
  };
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function jsonOk(data: unknown, status = 200, request?: Request, env?: Env): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (request) Object.assign(headers, getCorsHeaders(request, env));
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (request) Object.assign(headers, getCorsHeaders(request, env));
  return new Response(
    JSON.stringify({ success: false, errorCode: code, message, request_id: requestId, ...extra }),
    { status, headers }
  );
}

export function handleError(err: unknown, requestId: string, request?: Request, env?: Env): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
    return new Response(
      JSON.stringify({ success: false, errorCode: ERROR_CODES.RATE_LIMIT_EXCEEDED, message: 'Rate limit exceeded', request_id: requestId }),
      { status: 429, headers: { ...headers, 'Retry-After': String(err.retryAfter) } }
    );
  }
  if (err instanceof ProviderError) {
    return new Response(
      JSON.stringify({ success: false, errorCode: ERROR_CODES.PROVIDER_ERROR, message: err.message, request_id: requestId }),
      { status: 502, headers }
    );
  }
  if (err instanceof WorkerError) {
    return new Response(
      JSON.stringify({ success: false, errorCode: err.code, message: err.message, request_id: requestId }),
      { status: err.status, headers }
    );
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  return new Response(
    JSON.stringify({ success: false, errorCode: ERROR_CODES.INTERNAL_ERROR, message, request_id: requestId }),
    { status: 500, headers }
  );
}
