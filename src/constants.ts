/// <reference types="@cloudflare/workers-types" />

export const API_VERSION = '1.0.0';

export const API_KEY_BYTE_LENGTH = 24;

export const MAX_REQUEST_BODY_SIZE = 1_000_000;

export const MAX_IMAGE_BATCH_SIZE = 5;
export const MAX_IMAGE_REQUEST_BODY_SIZE = 20_000_000;
export const ALLOWED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'] as const;

export const MAX_DOC_REQUEST_BODY_SIZE = 10_000_000;
export const MAX_DOC_BINARY_SIZE = 2_000_000;
export const ALLOWED_DOC_TYPES = {
  'application/pdf': { ext: 'pdf', label: 'PDF' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', label: 'Word' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', label: 'Excel' },
} as const;
export type AllowedDocMimeType = keyof typeof ALLOWED_DOC_TYPES;

export const DOC_CHUNK_SIZE = 8_000;
export const DOC_CHUNK_OVERLAP = 400;
export const DOC_MAX_CHUNKS = 50;
export const DOC_MAX_PAGES = 100;
export const DOC_CHARS_PER_PAGE = 3_000;
export const DOC_MIN_CONTENT_CHARS = 50;
export const DOC_BATCH_SIZE = 10;

export const TEXT_MAX_CHARS = 120_000; // ~30K tokens — respects Voyage 32K token context window

export const VOYAGE_TIMEOUT_MS = 30_000;
export const RETRY_DELAY_MS = 1_000;
export const MAX_RETRIES = 3;

// Per-tenant rate limits (requests per window)
// NOTE: KV-based rate limiting is not atomic — concurrent bursts can bypass limits.
// Limits are set conservatively to reduce blast radius. Use Durable Objects for strict enforcement.
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMITS: Record<'text' | 'image' | 'doc', number> = {
  text:  30,   // 30 req/min per tenant (conservative — KV not atomic)
  image: 15,   // 15 req/min per tenant
  doc:   100,  // 100 req/min per tenant
};

export const CORS_MAX_AGE = 86400;

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_INPUT: 'INVALID_INPUT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  TENANT_EXISTS: 'TENANT_EXISTS',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
} as const;
