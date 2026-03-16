/// <reference types="@cloudflare/workers-types" />

export const API_VERSION = '1.0.0';
export const SERVICE_NAME = 'embedding-worker';

// Input limits
export const MAX_INPUT_CHARS = 32000;   // per string item
export const MAX_BATCH_SIZE = 10;       // max items in array input
export const MAX_REQUEST_BODY_SIZE = 1_000_000; // 1MB

// Timeouts & retry
export const OPENROUTER_TIMEOUT_MS = 10000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const RETRY_DELAY_MS = 500;
export const MAX_RETRIES = 1;

// CORS
export const CORS_MAX_AGE = 86400;

// Error codes
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_INPUT: 'INVALID_INPUT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;
