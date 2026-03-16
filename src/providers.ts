/// <reference types="@cloudflare/workers-types" />

// ─────────────────────────────────────────────────────────────
// PROVIDERS CONFIG
// This is the single file to edit when:
// - Adding a new provider
// - Changing the default model
// - Updating pricing
// - Adding image/doc models in phase 2
// ─────────────────────────────────────────────────────────────

export interface ModelConfig {
  id: string;           // model identifier sent to provider API
  dimensions: number;   // output embedding dimensions
  costPer1M: number;    // USD per 1M tokens
}

export interface ProviderConfig {
  name: string;
  endpoint: string;
  models: Record<string, ModelConfig>;
  defaultModel: string; // key into models
}

// ─────────────────────────────────────────────────────────────
// OpenRouter
// ─────────────────────────────────────────────────────────────
export const OPENROUTER: ProviderConfig = {
  name: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1/embeddings',
  defaultModel: 'text-embedding-3-small',
  models: {
    'text-embedding-3-small': {
      id: 'openai/text-embedding-3-small',
      dimensions: 1536,
      costPer1M: 0.02,
    }
  },
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** All valid model keys a tenant can be assigned */
export const ALLOWED_MODEL_KEYS = Object.keys(OPENROUTER.models);

/** Resolve a model key to its full config — falls back to default */
export function resolveModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && OPENROUTER.models[modelKey]
    ? modelKey
    : OPENROUTER.defaultModel;
  return OPENROUTER.models[key];
}
