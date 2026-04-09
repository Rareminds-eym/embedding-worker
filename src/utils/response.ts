/// <reference types="@cloudflare/workers-types" />

import { CORS_MAX_AGE, ERROR_CODES } from '../constants';
import type { Env } from '../types';
import { AuthError, ValidationError, ProviderError, RateLimitError, WorkerError } from '../types';

export function generateRequestId(): string {
  return crypto.randomUUID();
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

export function validateCorsOrigins(originsString: string): void {
  for (const origin of originsString.split(',').map(o => o.trim())) {
    if (origin === '*') {
      throw new Error('Wildcard CORS origin not allowed');
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin "${origin}": not a valid URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Invalid CORS origin "${origin}": unsupported protocol ${url.protocol}`);
    }
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(`Non-HTTPS origin not permitted: ${origin}`);
    }
  }
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
    headers['Vary'] = 'Origin';
    if (allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  }
  return headers;
}

function buildHeaders(requestId: string, request?: Request, env?: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    ...SECURITY_HEADERS,
  };
  if (request) {
    Object.assign(headers, getCorsHeaders(request, env));
  }
  return headers;
}

export function jsonOk(data: unknown, status = 200, request?: Request, env?: Env, requestId?: string): Response {
  const headers = requestId ? buildHeaders(requestId, request, env) : {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
    ...(request ? getCorsHeaders(request, env) : {}),
  };
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
  const headers = buildHeaders(requestId, request, env);
  return new Response(
    JSON.stringify({ success: false, errorCode: code, message, request_id: requestId, ...extra }),
    { status, headers }
  );
}

export function handleError(err: unknown, requestId: string, request?: Request, env?: Env): Response {
  const headers = buildHeaders(requestId, request, env);

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
    if (err.retryAfterSeconds !== undefined) {
      headers['Retry-After'] = String(err.retryAfterSeconds);
    }
    return new Response(
      JSON.stringify({ 
        success: false, 
        errorCode: ERROR_CODES.RATE_LIMIT_EXCEEDED, 
        message: err.message, 
        request_id: requestId,
        ...(err.retryAfterSeconds !== undefined && { retry_after_seconds: err.retryAfterSeconds })
      }),
      { status: 429, headers }
    );
  }
  if (err instanceof ProviderError) {
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
    console.error(JSON.stringify({
      event: 'unhandled_error',
      request_id: requestId,
      message: err.message,
      name: err.name,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    }));
  }
  return new Response(
    JSON.stringify({ success: false, errorCode: ERROR_CODES.INTERNAL_ERROR, message: 'Internal server error', request_id: requestId }),
    { status: 500, headers }
  );
}
