/// <reference types="@cloudflare/workers-types" />

import { ProviderError, RateLimitError } from './types';
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
  defaultTextModel:  'voyage-4',
  defaultDocModel:   'voyage-4',
  defaultImageModel: 'voyage-multimodal-3.5',
  textModelKeys:  ['voyage-4', 'voyage-4-lite', 'voyage-4-large', 'voyage-3', 'voyage-3-lite'],
  imageModelKeys: ['voyage-multimodal-3.5', 'voyage-multimodal-3'],
  models: {
    // Current generation (voyage-4 series) — 200M free tokens each
    'voyage-4':             { id: 'voyage-4',       dimensions: 1024, costPer1M: 0.06 },
    'voyage-4-lite':        { id: 'voyage-4-lite',  dimensions: 1024, costPer1M: 0.02 },
    'voyage-4-large':       { id: 'voyage-4-large', dimensions: 1024, costPer1M: 0.12 },
    // Legacy — kept for backward compatibility
    'voyage-3':             { id: 'voyage-3',       dimensions: 1024, costPer1M: 0.06 },
    'voyage-3-lite':        { id: 'voyage-3-lite',  dimensions: 512,  costPer1M: 0.02 },
    // Multimodal
    'voyage-multimodal-3.5':{ id: 'voyage-multimodal-3.5', dimensions: 1024, costPer1M: 0.12 },
    'voyage-multimodal-3':  { id: 'voyage-multimodal-3',   dimensions: 1024, costPer1M: 0.12 },
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

// Shared retry/error loop for all Voyage endpoints
async function callVoyageEndpoint<T>(
  endpoint: string,
  body: object,
  validate: (json: unknown, inputLength: number) => T,
  inputLength: number,
  endpointName: string,
  apiKey: string,
  tenantId: string,
  model: string,
  extraLogFields?: Record<string, unknown>,
): Promise<T> {
  let attempt = 0;

  while (true) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      throw new ProviderError(`${endpointName} provider unreachable`, 502);
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : retryAfterHeader
          ? Math.max(0, Date.parse(retryAfterHeader) - Date.now())
          : 2000;
      await new Promise(r => setTimeout(r, retryAfterMs));
      attempt++;
      continue;
    }

    if (res.status === 429) {
      // All retries exhausted — surface Retry-After to caller
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      console.error(JSON.stringify({ event: 'provider.rate_limit', provider: VOYAGE.name, endpoint: endpointName, tenant_id: tenantId, model, retry_after: retryAfterSeconds, ...extraLogFields }));
      throw new RateLimitError(
        `Rate limit exceeded. ${Number.isFinite(retryAfterSeconds) ? `Retry after ${retryAfterSeconds}s.` : 'Please wait before retrying.'}`,
        retryAfterSeconds,
      );
    }

    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
      attempt++;
      continue;
    }

    if (!res.ok) {
      console.error(JSON.stringify({ event: 'provider.error', provider: VOYAGE.name, endpoint: endpointName, status: res.status, tenant_id: tenantId, model, ...extraLogFields }));
      throw new ProviderError(`${endpointName} provider error (${res.status})`, res.status);
    }

    return validate(await res.json(), inputLength);
  }
}

export async function callTextProvider(
  inputs: string[],
  model: string,
  apiKey: string,
  tenantId: string,
): Promise<TextProviderResponse> {
  return callVoyageEndpoint<TextProviderResponse>(
    VOYAGE.textEndpoint,
    { model, input: inputs },
    (json) => {
      const j = json as TextProviderResponse;
      if (!j?.data || !Array.isArray(j.data) || j.data.length === 0) {
        console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'text', tenant_id: tenantId, model }));
        throw new ProviderError('Invalid response from embedding provider', 502);
      }
      return j;
    },
    inputs.length, 'text', apiKey, tenantId, model,
  );
}

export async function callImageProvider(
  inputs: VoyageRequestItem[],
  model: string,
  apiKey: string,
  tenantId: string,
): Promise<ImageProviderResponse> {
  return callVoyageEndpoint<ImageProviderResponse>(
    VOYAGE.imageEndpoint,
    { model, inputs },
    (json, inputLength) => {
      const j = json as ImageProviderResponse;
      if (!j?.data || !Array.isArray(j.data) || j.data.length === 0) {
        console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'image', tenant_id: tenantId, model }));
        throw new ProviderError('Invalid response from image embedding provider', 502);
      }
      if (j.data.length !== inputLength) {
        console.error(JSON.stringify({ event: 'provider.partial_response', provider: VOYAGE.name, endpoint: 'image', tenant_id: tenantId, model, expected: inputLength, received: j.data.length }));
        throw new ProviderError('Partial response from image embedding provider', 502);
      }
      return j;
    },
    inputs.length, 'image', apiKey, tenantId, model,
  );
}

async function callDocBatch(
  batch: string[],
  batchStart: number,
  model: string,
  apiKey: string,
  tenantId: string,
): Promise<{ embeddings: { index: number; embedding: number[] }[]; total_tokens: number }> {
  const res = await callVoyageEndpoint<TextProviderResponse>(
    VOYAGE.textEndpoint,
    { model, input: batch },
    (json, inputLength) => {
      const j = json as TextProviderResponse;
      if (!j?.data || !Array.isArray(j.data) || j.data.length === 0) {
        throw new ProviderError('Invalid response from embedding provider', 502);
      }
      if (j.data.length !== inputLength) {
        console.error(JSON.stringify({ event: 'provider.partial_response', provider: VOYAGE.name, endpoint: 'doc', tenant_id: tenantId, model, expected: inputLength, received: j.data.length, batch_start: batchStart }));
        throw new ProviderError('Partial response from embedding provider', 502);
      }
      return j;
    },
    batch.length, 'doc', apiKey, tenantId, model, { batch_start: batchStart },
  );
  return {
    embeddings: res.data.map((item, j) => ({ index: batchStart + j, embedding: item.embedding })),
    total_tokens: res.usage?.total_tokens ?? 0,
  };
}

export async function callDocProvider(
  chunks: string[],
  model: string,
  apiKey: string,
  tenantId: string,
): Promise<DocProviderResponse> {
  // Sequential batches — same 3 RPM limit as text endpoint, parallel would 429 immediately
  const result: DocProviderResponse = { embeddings: [], total_tokens: 0 };

  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) {
    const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
    const { embeddings, total_tokens } = await callDocBatch(batch, i, model, apiKey, tenantId);
    result.embeddings.push(...embeddings);
    result.total_tokens += total_tokens;
  }

  return result;
}
