/// <reference types="@cloudflare/workers-types" />

export const API_VERSION = '1.0.0';
export const SERVICE_NAME = 'embedding-worker';

// Input limits
export const MAX_INPUT_CHARS = 32000;   // per string item
export const MAX_BATCH_SIZE = 10;       // max items in array input
export const MAX_REQUEST_BODY_SIZE = 1_000_000; // 1MB

// Image limits
export const MAX_IMAGE_BATCH_SIZE = 5;
export const MAX_IMAGE_REQUEST_BODY_SIZE = 20_000_000; // 20MB (base64 images can be large)
export const ALLOWED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'] as const;

// Doc limits
export const MAX_DOC_REQUEST_BODY_SIZE = 10_000_000; // 10MB
export const ALLOWED_DOC_TYPES = {
  'application/pdf': { ext: 'pdf', label: 'PDF' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', label: 'Word' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', label: 'Excel' },
} as const;
export type AllowedDocMimeType = keyof typeof ALLOWED_DOC_TYPES;
export const VOYAGE_TIMEOUT_MS = 30000; // used for both text and image
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
