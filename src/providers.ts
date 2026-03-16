/// <reference types="@cloudflare/workers-types" />

// ─────────────────────────────────────────────────────────────
// PROVIDERS CONFIG
// This is the single file to edit when:
// - Adding a new provider
// - Changing the default model
// - Updating pricing
// - Swapping providers for text/image/doc
//
// Current setup: Voyage AI for BOTH text and image embeddings
// ─────────────────────────────────────────────────────────────

import { ProviderError } from './types';
import {
  VOYAGE_TIMEOUT_MS,
  RETRY_DELAY_MS,
  MAX_RETRIES,
} from './constants';

export interface ModelConfig {
  id: string;           // model identifier sent to provider API
  dimensions: number;   // output embedding dimensions
  costPer1M: number;    // USD per 1M tokens
}

export interface ProviderConfig {
  name: string;
  textEndpoint: string;       // for text embeddings
  imageEndpoint: string;      // for image/multimodal embeddings
  models: Record<string, ModelConfig>;
  defaultTextModel: string;
  defaultImageModel: string;
}

// ─────────────────────────────────────────────────────────────
// Voyage AI  (text + image embeddings)
// To swap provider: update name, endpoints, models below.
// callTextProvider / callImageProvider stay the same.
// ─────────────────────────────────────────────────────────────
export const VOYAGE: ProviderConfig = {
  name: 'voyage',
  textEndpoint:  'https://api.voyageai.com/v1/embeddings',
  imageEndpoint: 'https://api.voyageai.com/v1/multimodalembeddings',
  defaultTextModel:  'voyage-3',
  defaultImageModel: 'voyage-multimodal-3.5',
  models: {
    'voyage-3': {
      id: 'voyage-3',
      dimensions: 1024,
      costPer1M: 0.06,
    },
    'voyage-3-lite': {
      id: 'voyage-3-lite',
      dimensions: 512,
      costPer1M: 0.02,
    },
    'voyage-multimodal-3.5': {
      id: 'voyage-multimodal-3.5',
      dimensions: 1024,
      costPer1M: 0.12,
    },
    'voyage-multimodal-3': {
      id: 'voyage-multimodal-3',
      dimensions: 1024,
      costPer1M: 0.12,
    },
  },
};

// ─────────────────────────────────────────────────────────────
// Model resolvers
// ─────────────────────────────────────────────────────────────

export const ALLOWED_MODEL_KEYS = Object.keys(VOYAGE.models);

/** Resolve a text model key → config, falls back to default */
export function resolveModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && VOYAGE.models[modelKey] ? modelKey : VOYAGE.defaultTextModel;
  return VOYAGE.models[key];
}

/** Resolve an image model key → config, falls back to default */
export function resolveImageModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && VOYAGE.models[modelKey] ? modelKey : VOYAGE.defaultImageModel;
  return VOYAGE.models[key];
}

// ─────────────────────────────────────────────────────────────
// Provider callers
// All HTTP logic lives here. Handlers never touch endpoints.
// To swap provider: update VOYAGE config above + endpoints below.
// ─────────────────────────────────────────────────────────────

export interface TextProviderResponse {
  data: { embedding: number[] }[];
  usage: { total_tokens: number };
}

export interface ImageProviderResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

// Voyage multimodal input shape — exported so image handler can build it
// image_base64 value must be a data URL: "data:<mediatype>;base64,<data>"
export interface VoyageImageContent {
  type: 'image_url' | 'image_base64' | 'text';
  image_url?: string;
  image_base64?: string; // format: "data:image/png;base64,<data>"
  text?: string;
}

export interface VoyageRequestItem {
  content: VoyageImageContent[];
}

/** Call Voyage text embeddings endpoint */
export async function callTextProvider(
  inputs: string[],
  model: string,
  apiKey: string,
  tenantId: string,
  attempt = 0
): Promise<TextProviderResponse> {
  const res = await fetch(VOYAGE.textEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
  });

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    return callTextProvider(inputs, model, apiKey, tenantId, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(JSON.stringify({
      event: 'provider.error',
      provider: VOYAGE.name,
      endpoint: 'text',
      status: res.status,
      body: errText.slice(0, 500),
      tenant_id: tenantId,
      model,
    }));
    throw new ProviderError(`Embedding provider error (${res.status})`, res.status);
  }

  const json = await res.json() as TextProviderResponse;
  if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
    console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'text', tenant_id: tenantId, model }));
    throw new ProviderError('Invalid response from embedding provider', 502);
  }

  return json;
}

/** Call Voyage multimodal image embeddings endpoint */
export async function callImageProvider(
  inputs: VoyageRequestItem[],
  model: string,
  apiKey: string,
  tenantId: string,
  attempt = 0
): Promise<ImageProviderResponse> {
  const res = await fetch(VOYAGE.imageEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, inputs }),
    signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
  });

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    return callImageProvider(inputs, model, apiKey, tenantId, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(JSON.stringify({
      event: 'provider.error',
      provider: VOYAGE.name,
      endpoint: 'image',
      status: res.status,
      body: errText.slice(0, 500),
      tenant_id: tenantId,
      model,
    }));
    throw new ProviderError(`Image embedding provider error (${res.status})`, res.status);
  }

  const json = await res.json() as ImageProviderResponse;
  if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
    console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'image', tenant_id: tenantId, model }));
    throw new ProviderError('Invalid response from image embedding provider', 502);
  }

  return json;
}
