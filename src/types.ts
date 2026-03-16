/// <reference types="@cloudflare/workers-types" />

export interface Env {
  EMBEDDING_KV: KVNamespace;
  ADMIN_KEY: string;
  OPENROUTER_API_KEY: string;
  VOYAGE_API_KEY: string;
  ALLOWED_ORIGINS: string;
  ENVIRONMENT: string;
}

export interface TenantConfig {
  name: string;
  created_at: string;
}

export interface ApiKeyRecord {
  tenant_id: string;
  created_at: string;
}

export interface RequestContext {
  tenantId: string;
  tenant: TenantConfig;
  requestId: string;
  startTime: number;
}

export interface EmbeddingItem {
  index: number;
  embedding: number[];
  dimensions: number;
}

// ── Error classes ──────────────────────────────────────────

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

export class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
  }
}

export class ProviderError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class WorkerError extends Error {
  constructor(message: string, public code: string, public status: number = 500) {
    super(message);
    this.name = 'WorkerError';
  }
}
