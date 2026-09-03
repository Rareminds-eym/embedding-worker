/// <reference types="@cloudflare/workers-types" />

export interface Env {
  EMBEDDING_KV: KVNamespace;
  /** Single shared API key for all authorized HTTP callers. */
  EMBEDDING_API_KEY: string;
  OPENROUTER_API_KEY: string;
  ALLOWED_ORIGINS: string;
  ENVIRONMENT: string;
  AI: Ai;
  RATE_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> };
}

export interface RequestContext {
  /** Synthetic caller id for rate-limit bucketing and log correlation. */
  callerId: string;
  requestId: string;
  startTime: number;
}

export interface EmbeddingItem {
  index: number;
  embedding: number[];
  dimensions: number;
}

export class AuthError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ProviderError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends Error {
  constructor(message: string, public retryAfterSeconds?: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class WorkerError extends Error {
  constructor(message: string, public code: string, public status: number = 500) {
    super(message);
    this.name = 'WorkerError';
  }
}
