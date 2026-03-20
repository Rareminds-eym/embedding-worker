/// <reference types="@cloudflare/workers-types" />

import { ProviderError, RateLimitError } from './types';
import { VOYAGE_TIMEOUT_MS, RETRY_DELAY_MS, MAX_RETRIES, DOC_BATCH_SIZE, MAX_DOC_BATCH_CONCURRENCY } from './constants';

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
  defaultImageModel: string;
  textModelKeys: string[];
  imageModelKeys: string[];
}

export const VOYAGE: ProviderConfig = {
  name: 'voyage',
  textEndpoint:  'https://api.voyageai.com/v1/embeddings',
  imageEndpoint: 'https://api.voyageai.com/v1/multimodalembeddings',
  defaultTextModel:  'voyage-4',
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

// NOTE: Despite the name, text embeddings are routed through OpenRouter
// (https://openrouter.ai), not directly to OpenAI. The model is OpenAI's
// text-embedding-3-small served via OpenRouter's proxy. If this endpoint
// is down, check https://status.openrouter.ai — not OpenAI's status page.
export const OPENAI = {
  name: 'openrouter',
  textEndpoint: 'https://openrouter.ai/api/v1/embeddings',
  defaultModel: 'openai/text-embedding-3-small',
  model: { id: 'text-embedding-3-small', dimensions: 1536, costPer1M: 0.02 } as ModelConfig,
};

export function resolveImageModel(modelKey: string | undefined): ModelConfig {
  const key = modelKey && VOYAGE.imageModelKeys.includes(modelKey) ? modelKey : VOYAGE.defaultImageModel;
  return VOYAGE.models[key];
}

export interface TextProviderResponse {
  data: { embedding: number[] }[];
  usage: { total_tokens: number };
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

interface RetryContext {
  providerName: string;
  endpointName: string;
  tenantId: string;
  model: string;
  extraLogFields?: Record<string, unknown>;
}

async function callWithRetry<T>(
  url: string,
  headers: Record<string, string>,
  body: object,
  validate: (json: unknown) => T,
  ctx: RetryContext,
): Promise<T> {
  const TOTAL_DEADLINE_MS = 25_000;
  const deadline = Date.now() + TOTAL_DEADLINE_MS;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        if (Date.now() + delay > deadline) throw new ProviderError(`${ctx.endpointName} provider unreachable`, 502);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new ProviderError(`${ctx.endpointName} provider unreachable`, 502);
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : retryAfterHeader
          ? Math.max(0, Date.parse(retryAfterHeader) - Date.now())
          : 2000;
      if (Date.now() + retryAfterMs > deadline) {
        const retryAfterSeconds2 = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        throw new RateLimitError('Rate limit exceeded. Please wait before retrying.', retryAfterSeconds2);
      }
      await new Promise(r => setTimeout(r, retryAfterMs));
      continue;
    }

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      console.error(JSON.stringify({ event: 'provider.rate_limit', provider: ctx.providerName, endpoint: ctx.endpointName, tenant_id: ctx.tenantId, model: ctx.model, retry_after: retryAfterSeconds, ...ctx.extraLogFields }));
      throw new RateLimitError(
        `Rate limit exceeded. ${Number.isFinite(retryAfterSeconds) ? `Retry after ${retryAfterSeconds}s.` : 'Please wait before retrying.'}`,
        retryAfterSeconds,
      );
    }

    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      if (Date.now() + delay > deadline) throw new ProviderError(`${ctx.endpointName} provider error (${res.status})`, res.status);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      console.error(JSON.stringify({ event: 'provider.error', provider: ctx.providerName, endpoint: ctx.endpointName, status: res.status, tenant_id: ctx.tenantId, model: ctx.model, body: errorBody.slice(0, 500), ...ctx.extraLogFields }));
      throw new ProviderError(`${ctx.endpointName} provider error (${res.status})`, res.status);
    }

    try {
      return validate(await res.json());
    } catch (err) {
      if (err instanceof ProviderError || err instanceof RateLimitError) throw err;
      console.error(JSON.stringify({
        event: 'provider.invalid_response',
        provider: ctx.providerName,
        endpoint: ctx.endpointName,
        tenant_id: ctx.tenantId,
        model: ctx.model,
        error: err instanceof Error ? err.message : String(err),
        ...ctx.extraLogFields,
      }));
      throw new ProviderError(`${ctx.endpointName} provider returned an invalid response`, 502);
    }
  }
}

async function callOpenAIEmbeddings(
  inputs: string[],
  apiKey: string,
  tenantId: string,
  endpointName: string,
): Promise<{ data: { embedding: number[] }[]; usage: { total_tokens: number } }> {
  return callWithRetry(
    OPENAI.textEndpoint,
    { 'Authorization': `Bearer ${apiKey}` },
    { model: OPENAI.defaultModel, input: inputs },
    (json) => {
      const j = json as { data: { embedding: number[]; index: number }[]; usage: { prompt_tokens: number; total_tokens: number } };
      if (!j?.data || !Array.isArray(j.data) || j.data.length !== inputs.length) {
        throw new ProviderError(`Invalid response from ${OPENAI.name}`, 502);
      }
      const ordered: ({ embedding: number[] } | null)[] = Array(inputs.length).fill(null);
      for (const item of j.data) {
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= inputs.length ||
          ordered[item.index] !== null
        ) {
          throw new ProviderError(`Invalid response from ${OPENAI.name}`, 502);
        }
        ordered[item.index] = { embedding: item.embedding };
      }
      if (ordered.some((item) => item === null)) {
        throw new ProviderError(`Invalid response from ${OPENAI.name}`, 502);
      }
      return {
        data: ordered.map((item) => item!),
        usage: { total_tokens: j.usage?.total_tokens ?? 0 },
      };
    },
    { providerName: OPENAI.name, endpointName, tenantId, model: OPENAI.defaultModel },
  );
}

export async function callImageProvider(
  inputs: VoyageRequestItem[],
  model: string,
  apiKey: string,
  tenantId: string,
): Promise<ImageProviderResponse> {
  return callWithRetry(
    VOYAGE.imageEndpoint,
    { 'Authorization': `Bearer ${apiKey}` },
    { model, inputs },
    (json) => {
      const j = json as ImageProviderResponse;
      if (!j?.data || !Array.isArray(j.data) || j.data.length === 0) {
        console.error(JSON.stringify({ event: 'provider.invalid_response', provider: VOYAGE.name, endpoint: 'image', tenant_id: tenantId, model }));
        throw new ProviderError('Invalid response from image embedding provider', 502);
      }
      if (j.data.length !== inputs.length) {
        console.error(JSON.stringify({ event: 'provider.partial_response', provider: VOYAGE.name, endpoint: 'image', tenant_id: tenantId, model, expected: inputs.length, received: j.data.length }));
        throw new ProviderError('Partial response from image embedding provider', 502);
      }
      return j;
    },
    { providerName: VOYAGE.name, endpointName: 'image', tenantId, model },
  );
}

export async function callTextProvider(
  inputs: string[],
  apiKey: string,
  tenantId: string,
): Promise<TextProviderResponse> {
  const res = await callOpenAIEmbeddings(inputs, apiKey, tenantId, 'text');
  return { ...res, _model: OPENAI.defaultModel, _provider: OPENAI.name };
}

export async function callDocProvider(
  chunks: string[],
  apiKey: string,
  tenantId: string,
): Promise<DocProviderResponse> {
  const result: DocProviderResponse = { embeddings: [], total_tokens: 0, _model: OPENAI.defaultModel, _provider: OPENAI.name };

  const batchStarts: number[] = [];
  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) batchStarts.push(i);

  const batchResults: { i: number; res: { data: { embedding: number[] }[]; usage: { total_tokens: number } } }[] = [];

  for (let offset = 0; offset < batchStarts.length; offset += MAX_DOC_BATCH_CONCURRENCY) {
    const batchWindow = batchStarts.slice(offset, offset + MAX_DOC_BATCH_CONCURRENCY);
    batchResults.push(...await Promise.all(
      batchWindow.map(async (i) => {
        const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
        const res = await callOpenAIEmbeddings(batch, apiKey, tenantId, 'doc');
        return { i, res };
      }),
    ));
  }

  batchResults.sort((a, b) => a.i - b.i);
  for (const { i, res } of batchResults) {
    result.embeddings.push(...res.data.map((item, j) => ({ index: i + j, embedding: item.embedding })));
    result.total_tokens += res.usage?.total_tokens ?? 0;
  }

  return result;
}
