/// <reference types="@cloudflare/workers-types" />

import { CORS_MAX_AGE, ERROR_CODES } from '../constants';
import type { Env } from '../types';
import { AuthError, ValidationError, ProviderError, RateLimitError, WorkerError } from '../types';

function buildBaseHeaders(request?: Request, env?: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (request) Object.assign(headers, getCorsHeaders(request, env));
  return headers;
}

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
  };
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

export function jsonOk(data: unknown, status = 200, request?: Request, env?: Env): Response {
  const headers = buildBaseHeaders(request, env);
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
  const headers = buildBaseHeaders(request, env);
  return new Response(
    JSON.stringify({ success: false, errorCode: code, message, request_id: requestId, ...extra }),
    { status, headers }
  );
}

export function handleError(err: unknown, requestId: string, request?: Request, env?: Env): Response {
  const headers = buildBaseHeaders(request, env);

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
    if (err.retryAfterSeconds !== undefined) extra['retry_after_seconds'] = err.retryAfterSeconds;
    return new Response(
      JSON.stringify({ success: false, errorCode: ERROR_CODES.RATE_LIMIT_EXCEEDED, message: err.message, request_id: requestId, ...extra }),
      { status: 429, headers }
    );
  }
  if (err instanceof ProviderError) {
    const status = err.status === 429 ? 429 : (err.status >= 400 && err.status < 600 ? err.status : 502);
    const errorCode = err.status === 429 ? ERROR_CODES.RATE_LIMIT_EXCEEDED : ERROR_CODES.PROVIDER_ERROR;
    const safeMessage = status >= 500 ? 'Upstream provider error' : err.message;
    return new Response(
      JSON.stringify({ success: false, errorCode, message: safeMessage, request_id: requestId }),
      { status, headers }
    );
  }
  if (err instanceof WorkerError) {
    return new Response(
      JSON.stringify({ success: false, errorCode: err.code, message: err.message, request_id: requestId }),
      { status: err.status, headers }
    );
  }

  const message = 'Internal server error';
  return new Response(
    JSON.stringify({ success: false, errorCode: ERROR_CODES.INTERNAL_ERROR, message, request_id: requestId }),
    { status: 500, headers }
  );
}
