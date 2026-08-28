/// <reference types="@cloudflare/workers-types" />

import { ProviderError, RateLimitError } from './types';
import {
  RETRY_DELAY_MS,
  MAX_RETRIES,
  DOC_BATCH_SIZE,
  MAX_DOC_BATCH_CONCURRENCY,
  PROVIDER_TOTAL_DEADLINE_MS,
  PROVIDER_MIN_TIMEOUT_MS,
  PROVIDER_DEFAULT_RETRY_MS,
} from './constants';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = 'google/gemini-embedding-2-preview';
export const OPENROUTER_TIMEOUT_MS = 30_000;
const OPENROUTER_OUTPUT_DIM = 1536;
const PROVIDER_ERROR_PREVIEW = 200;

export const GEMINI_MODEL_ID = OPENROUTER_MODEL;
export const GEMINI_DIMENSIONS = OPENROUTER_OUTPUT_DIM;

export const GEMINI_TASK_TYPES = [
  'RETRIEVAL_DOCUMENT',
  'RETRIEVAL_QUERY',
  'SEMANTIC_SIMILARITY',
  'CLASSIFICATION',
  'CLUSTERING',
  'QUESTION_ANSWERING',
  'FACT_VERIFICATION',
  'CODE_RETRIEVAL_QUERY',
] as const;

export type GeminiTaskType = typeof GEMINI_TASK_TYPES[number];

export const GEMINI_DEFAULT_TASK_TYPE: GeminiTaskType = 'RETRIEVAL_DOCUMENT';

export interface TextProviderResponse {
  embedding: number[];
}

export interface DocProviderResponse {
  embeddings: { index: number; embedding: number[] }[];
}

interface OpenRouterEmbeddingItem {
  object: 'embedding';
  index: number;
  embedding: number[];
}

interface OpenRouterEmbeddingsResponse {
  object: 'list';
  data: OpenRouterEmbeddingItem[];
  model: string;
}

function isOpenRouterEmbeddingsResponse(json: unknown): json is OpenRouterEmbeddingsResponse {
  if (!json || typeof json !== 'object') return false;
  const j = json as Record<string, unknown>;
  if (j.object !== 'list' || !Array.isArray(j.data)) return false;
  return j.data.every(item => {
    if (!item || typeof item !== 'object') return false;
    const i = item as Record<string, unknown>;
    return Array.isArray(i.embedding) && i.embedding.length > 0;
  });
}

function mapTaskTypeToInputType(taskType?: string): string | undefined {
  if (!taskType) return undefined;
  if (taskType === 'RETRIEVAL_QUERY' || taskType === 'CODE_RETRIEVAL_QUERY') {
    return 'search_query';
  }
  if (taskType === 'RETRIEVAL_DOCUMENT') {
    return 'search_document';
  }
  return undefined;
}

interface RetryContext {
  endpoint: string;
  callerId: string;
}

async function callWithRetry<T>(
  url: string,
  headers: Headers,
  body: object,
  validate: (json: unknown) => T,
  ctx: RetryContext,
): Promise<T> {
  const deadline = Date.now() + PROVIDER_TOTAL_DEADLINE_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ProviderError(`${ctx.endpoint} timeout (deadline exceeded)`, 502);
    }
    if (remainingMs < PROVIDER_MIN_TIMEOUT_MS) {
      throw new ProviderError(`${ctx.endpoint} timeout (${remainingMs}ms remaining)`, 502);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: new Headers(headers),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(PROVIDER_MIN_TIMEOUT_MS, Math.min(OPENROUTER_TIMEOUT_MS, remainingMs))),
      });
    } catch (err) {
      console.error(JSON.stringify({ event: 'provider.request_failed', endpoint: ctx.endpoint, caller_id: ctx.callerId, attempt: attempt + 1, error: err instanceof Error ? err.message : String(err) }));
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, attempt), 30_000);
        if (Date.now() + delay > deadline) throw new ProviderError(`${ctx.endpoint} timeout after ${attempt + 1} attempts`, 502);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new ProviderError(`${ctx.endpoint} unreachable: ${err instanceof Error ? err.message : String(err)}`, 502);
    }

    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(res.headers.get('Retry-After'));
      if (attempt < MAX_RETRIES) {
        const retryMs = retryAfterSeconds ? retryAfterSeconds * 1000 : PROVIDER_DEFAULT_RETRY_MS;
        if (Date.now() + retryMs > deadline) throw new RateLimitError('Rate limit exceeded. Please wait before retrying.', retryAfterSeconds);
        await new Promise(r => setTimeout(r, retryMs));
        continue;
      }
      console.error(JSON.stringify({ event: 'provider.rate_limit', endpoint: ctx.endpoint, caller_id: ctx.callerId }));
      throw new RateLimitError(
        retryAfterSeconds ? `Rate limit exceeded. Retry after ${retryAfterSeconds}s.` : 'Rate limit exceeded. Please wait before retrying.',
        retryAfterSeconds,
      );
    }

    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, attempt), 30_000);
      if (Date.now() + delay > deadline) throw new ProviderError(`${ctx.endpoint} error (${res.status})`, res.status);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(JSON.stringify({ event: 'provider.error', endpoint: ctx.endpoint, status: res.status, caller_id: ctx.callerId, response_preview: body.slice(0, PROVIDER_ERROR_PREVIEW) }));
      throw new ProviderError(`${ctx.endpoint} error (${res.status})`, res.status);
    }

    try {
      const json = await res.json();
      return validate(json);
    } catch (err) {
      if (err instanceof ProviderError || err instanceof RateLimitError) throw err;
      if (err instanceof SyntaxError || err instanceof TypeError) {
        throw new ProviderError(`${ctx.endpoint} returned invalid JSON`, 502);
      }
      console.error(JSON.stringify({ event: 'provider.invalid_response', endpoint: ctx.endpoint, caller_id: ctx.callerId, error: err instanceof Error ? err.message : String(err) }));
      throw new ProviderError(`${ctx.endpoint} returned an invalid response`, 502);
    }
  }

  throw new ProviderError(`${ctx.endpoint} unreachable`, 502);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3600) return seconds;
  const retryAt = Date.parse(header);
  if (!Number.isNaN(retryAt)) {
    const delta = Math.ceil((retryAt - Date.now()) / 1000);
    return (delta > 0 && delta <= 3600) ? delta : undefined;
  }
  return undefined;
}

async function callOpenRouterEmbeddings(
  input: string | string[] | Record<string, unknown>[],
  apiKey: string,
  callerId: string,
  endpointLabel: string,
  allowedOrigins: string,
  taskType?: string,
): Promise<number[][]> {
  const inputType = mapTaskTypeToInputType(taskType);
  const body: Record<string, unknown> = {
    model: OPENROUTER_MODEL,
    input,
    dimensions: OPENROUTER_OUTPUT_DIM,
  };
  if (inputType) {
    body.input_type = inputType;
  }

  const referer = allowedOrigins.split(',')[0]?.trim();
  if (!referer) {
    throw new ProviderError('allowedOrigins configuration is required for HTTP-Referer header', 500);
  }
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': referer,
    'X-Title': 'SkillPassport Embedding Service',
  });

  return callWithRetry(
    `${OPENROUTER_API_BASE}/embeddings`,
    headers,
    body,
    (json) => {
      if (!isOpenRouterEmbeddingsResponse(json)) {
        throw new ProviderError(`${endpointLabel} returned invalid response`, 502);
      }
      const sortedData = [...json.data].sort((a, b) => a.index - b.index);
      return sortedData.map(item => item.embedding);
    },
    { endpoint: endpointLabel, callerId },
  );
}

export async function callTextProvider(
  input: string,
  apiKey: string,
  callerId: string,
  allowedOrigins: string,
  taskType: string = GEMINI_DEFAULT_TASK_TYPE,
): Promise<TextProviderResponse> {
  const embeddings = await callOpenRouterEmbeddings(input, apiKey, callerId, 'text', allowedOrigins, taskType);
  if (embeddings.length === 0) throw new ProviderError('text: no embedding returned', 502);
  return { embedding: embeddings[0] };
}

export async function callImageProvider(
  image: { mime_type: string; data: string },
  apiKey: string,
  callerId: string,
  allowedOrigins: string,
): Promise<number[]> {
  const embeddings = await callOpenRouterEmbeddings(
    [
      {
        type: 'image_url',
        image_url: {
          url: `data:${image.mime_type};base64,${image.data}`,
        },
      },
    ],
    apiKey,
    callerId,
    'image',
    allowedOrigins,
  );
  if (embeddings.length === 0) throw new ProviderError('image: no embedding returned', 502);
  return embeddings[0];
}

export async function callDocProvider(
  chunks: string[],
  apiKey: string,
  callerId: string,
  allowedOrigins: string,
): Promise<DocProviderResponse> {
  const result: DocProviderResponse = {
    embeddings: Array.from({ length: chunks.length }, (_, i) => ({ index: i, embedding: [] as number[] })),
  };

  const batchStarts: number[] = [];
  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) batchStarts.push(i);

  for (let offset = 0; offset < batchStarts.length; offset += MAX_DOC_BATCH_CONCURRENCY) {
    await Promise.all(batchStarts.slice(offset, offset + MAX_DOC_BATCH_CONCURRENCY).map(async (i) => {
      const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
      const embeddings = await callOpenRouterEmbeddings(batch, apiKey, callerId, `batch[${i}-${i + batch.length - 1}]`, allowedOrigins, GEMINI_DEFAULT_TASK_TYPE);
      embeddings.forEach((embedding, j) => { result.embeddings[i + j] = { index: i + j, embedding }; });
    }));
  }

  if (result.embeddings.length === 0) {
    throw new ProviderError('doc: no embeddings returned', 502);
  }

  return result;
}
