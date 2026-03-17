/// <reference types="@cloudflare/workers-types" />

import { ProviderError } from './types';
import { VOYAGE_TIMEOUT_MS, RETRY_DELAY_MS, MAX_RETRIES, DOC_BATCH_SIZE } from './constants';

export interface ModelConfig {
  id: string;
  dimensions: number;
  costPer1M: number;
}

export interface ProviderConfig {
  name: string;
  textEndpoint: string;
  imageEndpoint: string;
  models: Record<string, ModelConfig>;
  defaultTextModel: string;
  defaultDocModel: string;
  defaultImageModel: string;
  textModelKeys: string[];
  imageModelKeys: string[];
}

export const VOYAGE: ProviderConfig = {
  name: 'voyage',
  textEndpoint:  'https://api.voyageai.com/v1/embeddings',
  imageEndpoint: 'https://api.voyageai.com/v1/multimodalembeddings',
  defaultTextModel:  'voyage-3',
  defaultDocModel:   'voyage-3',
  defaultImageModel: 'voyage-multimodal-3.5',
  textModelKeys:  ['voyage-3', 'voyage-3-lite'],
  imageModelKeys: ['voyage-multimodal-3.5', 'voyage-multimodal-3'],
  models: {
    'voyage-3':             { id: 'voyage-3',             dimensions: 1024, costPer1M: 0.06 },
    'voyage-3-lite':        { id: 'voyage-3-lite',        dimensions: 512,  costPer1M: 0.02 },
    'voyage-multimodal-3.5':{ id: 'voyage-multimodal-3.5',dimensions: 1024, costPer1M: 0.12 },
    'voyage-multimodal-3':  { id: 'voyage-multimodal-3',  dimensions: 1024, costPer1M: 0.12 },
  },
};

export function resolveModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && VOYAGE.textModelKeys.includes(modelKey) ? modelKey : VOYAGE.defaultTextModel;
  return VOYAGE.models[key];
}

export function resolveDocModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && VOYAGE.textModelKeys.includes(modelKey) ? modelKey : VOYAGE.defaultDocModel;
  return VOYAGE.models[key];
}

export function resolveImageModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && VOYAGE.imageModelKeys.includes(modelKey) ? modelKey : VOYAGE.defaultImageModel;
  return VOYAGE.models[key];
}

export interface TextProviderResponse {
  data: { embedding: number[] }[];
  usage: { total_tokens: number };
}

export interface DocProviderResponse {
  embeddings: { index: number; embedding: number[] }[];
  total_tokens: number;
}

export interface ImageProviderResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

export interface VoyageImageContent {
  type: 'image_url' | 'image_base64' | 'text';
  image_url?: string;
  image_base64?: string;
  text?: string;
}

export interface VoyageRequestItem {
  content: VoyageImageContent[];
}

export async function callTextProvider(
  inputs: string[],
  model: string,
  apiKey: string,
  tenantId: string,
  attempt = 0
): Promise<TextProviderResponse> {
  const res = await fetch(VOYAGE.textEndpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
  });

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    return callTextProvider(inputs, model, apiKey, tenantId, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(JSON.stringify({ event: 'provider.error', provider: VOYAGE.name, endpoint: 'text', status: res.status, body: errText.slice(0, 500), tenant_id: tenantId, model }));
    throw new ProviderError(`Embedding provider error (${res.status})`, res.status);
  }

  const json = await res.json() as TextProviderResponse;
  if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
    console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'text', tenant_id: tenantId, model }));
    throw new ProviderError('Invalid response from embedding provider', 502);
  }

  return json;
}

export async function callImageProvider(
  inputs: VoyageRequestItem[],
  model: string,
  apiKey: string,
  tenantId: string,
  attempt = 0
): Promise<ImageProviderResponse> {
  const res = await fetch(VOYAGE.imageEndpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, inputs }),
    signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
  });

  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    return callImageProvider(inputs, model, apiKey, tenantId, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(JSON.stringify({ event: 'provider.error', provider: VOYAGE.name, endpoint: 'image', status: res.status, body: errText.slice(0, 500), tenant_id: tenantId, model }));
    throw new ProviderError(`Image embedding provider error (${res.status})`, res.status);
  }

  const json = await res.json() as ImageProviderResponse;
  if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
    console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'image', tenant_id: tenantId, model }));
    throw new ProviderError('Invalid response from image embedding provider', 502);
  }

  return json;
}

export async function callDocProvider(
  chunks: string[],
  model: string,
  apiKey: string,
  tenantId: string,
): Promise<DocProviderResponse> {
  const result: DocProviderResponse = { embeddings: [], total_tokens: 0 };

  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) {
    const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
    let attempt = 0;

    while (true) {
      const res = await fetch(VOYAGE.textEndpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
      });

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '2', 10);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        attempt++;
        continue;
      }

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
        attempt++;
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(JSON.stringify({ event: 'provider.error', provider: VOYAGE.name, endpoint: 'doc', status: res.status, body: errText.slice(0, 500), tenant_id: tenantId, model, batch_start: i }));
        throw new ProviderError(`Embedding provider error (${res.status})`, res.status);
      }

      const json = await res.json() as TextProviderResponse;
      if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
        throw new ProviderError('Invalid response from embedding provider', 502);
      }

      json.data.forEach((item, j) => result.embeddings.push({ index: i + j, embedding: item.embedding }));
      result.total_tokens += json.usage?.total_tokens ?? 0;
      break;
    }
  }

  return result;
}
