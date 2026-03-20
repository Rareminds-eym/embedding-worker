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
  textModelKeys:  ['voyage-4', 'voyage-4-lite', 'voyage-4-large'],
  imageModelKeys: ['voyage-multimodal-3.5', 'voyage-multimodal-3'],
  models: {
    'voyage-4':              { id: 'voyage-4',              dimensions: 1024, costPer1M: 0.06 },
    'voyage-4-lite':         { id: 'voyage-4-lite',         dimensions: 1024, costPer1M: 0.02 },
    'voyage-4-large':        { id: 'voyage-4-large',        dimensions: 1024, costPer1M: 0.12 },
    'voyage-multimodal-3.5': { id: 'voyage-multimodal-3.5', dimensions: 1024, costPer1M: 0.12 },
    'voyage-multimodal-3':   { id: 'voyage-multimodal-3',   dimensions: 1024, costPer1M: 0.12 },
  },
};

// OpenAI via OpenRouter fallback — text/doc only, no image support
export const OPENAI = {
  name: 'openai',
  textEndpoint: 'https://openrouter.ai/api/v1/embeddings',
  defaultModel: 'openai/text-embedding-3-small',
  model: { id: 'text-embedding-3-small', dimensions: 1536, costPer1M: 0.02 } as ModelConfig,
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
  // actual model used — may differ from requested if fallback was triggered
  _model: string;
  _provider: string;
}

export interface DocProviderResponse {
  embeddings: { index: number; embedding: number[] }[];
  total_tokens: number;
  _model: string;
  _provider: string;
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

// ─── Voyage shared retry loop ────────────────────────────────────────────────

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

// ─── OpenAI fallback ─────────────────────────────────────────────────────────

// OpenAI uses the same /v1/embeddings shape as Voyage for text
async function callOpenAIEmbeddings(
  inputs: string[],
  apiKey: string,
  tenantId: string,
  endpointName: string,
): Promise<{ data: { embedding: number[] }[]; usage: { total_tokens: number } }> {
  let attempt = 0;

  while (true) {
    let res: Response;
    try {
      res = await fetch(OPENAI.textEndpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OPENAI.defaultModel, input: inputs }),
        signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      throw new ProviderError(`openai fallback unreachable`, 502);
    }

    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
      attempt++;
      continue;
    }

    if (!res.ok) {
      console.error(JSON.stringify({ event: 'provider.error', provider: OPENAI.name, endpoint: endpointName, status: res.status, tenant_id: tenantId, model: OPENAI.defaultModel }));
      throw new ProviderError(`openai fallback error (${res.status})`, res.status);
    }

    // OpenAI response: { data: [{ embedding, index }], usage: { prompt_tokens, total_tokens } }
    const json = await res.json() as { data: { embedding: number[]; index: number }[]; usage: { prompt_tokens: number; total_tokens: number } };
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      throw new ProviderError('Invalid response from openai fallback', 502);
    }
    // Sort by index to guarantee order matches input order (OpenAI may return out-of-order)
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      data: sorted.map(d => ({ embedding: d.embedding })),
      usage: { total_tokens: json.usage?.total_tokens ?? 0 },
    };
  }
}

// ─── Public provider functions ───────────────────────────────────────────────

export async function callTextProvider(
  inputs: string[],
  model: string,
  voyageApiKey: string,
  openaiApiKey: string,
  tenantId: string,
): Promise<TextProviderResponse> {
  try {
    const res = await callVoyageEndpoint<{ data: { embedding: number[] }[]; usage: { total_tokens: number } }>(
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
      inputs.length, 'text', voyageApiKey, tenantId, model,
    );
    return { ...res, _model: model, _provider: VOYAGE.name };
  } catch (err) {
    if ((err instanceof RateLimitError || err instanceof ProviderError) && openaiApiKey) {
      console.error(JSON.stringify({ event: 'provider.fallback', from: VOYAGE.name, to: OPENAI.name, endpoint: 'text', tenant_id: tenantId, reason: err.message }));
      const res = await callOpenAIEmbeddings(inputs, openaiApiKey, tenantId, 'text');
      return { ...res, _model: OPENAI.defaultModel, _provider: OPENAI.name };
    }
    throw err;
  }
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
  voyageApiKey: string,
  openaiApiKey: string,
  tenantId: string,
): Promise<{ embeddings: { index: number; embedding: number[] }[]; total_tokens: number; _model: string; _provider: string }> {
  try {
    const res = await callVoyageEndpoint<{ data: { embedding: number[] }[]; usage: { total_tokens: number } }>(
      VOYAGE.textEndpoint,
      { model, input: batch },
      (json, inputLength) => {
        const j = json as { data: { embedding: number[] }[]; usage: { total_tokens: number } };
        if (!j?.data || !Array.isArray(j.data) || j.data.length === 0) {
          throw new ProviderError('Invalid response from embedding provider', 502);
        }
        if (j.data.length !== inputLength) {
          console.error(JSON.stringify({ event: 'provider.partial_response', provider: VOYAGE.name, endpoint: 'doc', tenant_id: tenantId, model, expected: inputLength, received: j.data.length, batch_start: batchStart }));
          throw new ProviderError('Partial response from embedding provider', 502);
        }
        return j;
      },
      batch.length, 'doc', voyageApiKey, tenantId, model, { batch_start: batchStart },
    );
    return {
      embeddings: res.data.map((item, j) => ({ index: batchStart + j, embedding: item.embedding })),
      total_tokens: res.usage?.total_tokens ?? 0,
      _model: model,
      _provider: VOYAGE.name,
    };
  } catch (err) {
    if ((err instanceof RateLimitError || err instanceof ProviderError) && openaiApiKey) {
      console.error(JSON.stringify({ event: 'provider.fallback', from: VOYAGE.name, to: OPENAI.name, endpoint: 'doc', tenant_id: tenantId, batch_start: batchStart, reason: err.message }));
      const res = await callOpenAIEmbeddings(batch, openaiApiKey, tenantId, 'doc');
      return {
        embeddings: res.data.map((item, j) => ({ index: batchStart + j, embedding: item.embedding })),
        total_tokens: res.usage?.total_tokens ?? 0,
        _model: OPENAI.defaultModel,
        _provider: OPENAI.name,
      };
    }
    throw err;
  }
}

export async function callDocProvider(
  chunks: string[],
  model: string,
  voyageApiKey: string,
  openaiApiKey: string,
  tenantId: string,
): Promise<DocProviderResponse> {
  const result: DocProviderResponse = { embeddings: [], total_tokens: 0, _model: model, _provider: VOYAGE.name };

  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) {
    const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
    const { embeddings, total_tokens, _model, _provider } = await callDocBatch(batch, i, model, voyageApiKey, openaiApiKey, tenantId);
    result.embeddings.push(...embeddings);
    result.total_tokens += total_tokens;
    // Track if any batch fell back — last batch wins for reporting
    result._model = _model;
    result._provider = _provider;
  }

  return result;
}
