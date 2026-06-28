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

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-embedding-2-preview';
const GEMINI_AUTH_HEADER = 'x-goog-api-key';
export const GEMINI_TIMEOUT_MS = 30_000;
const GEMINI_OUTPUT_DIM = 3072;
const GEMINI_ERROR_PREVIEW = 200;

export const GEMINI_MODEL_ID = GEMINI_MODEL;
export const GEMINI_DIMENSIONS = GEMINI_OUTPUT_DIM;

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

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiEmbedRequest {
  content: { parts: GeminiPart[] };
  taskType?: string;
  output_dimensionality?: number;
}

interface GeminiEmbedResponse {
  embedding: { values: number[] };
}

interface GeminiBatchRequest {
  requests: Array<{ model: string } & GeminiEmbedRequest>;
}

interface GeminiBatchResponse {
  embeddings: Array<{ values: number[] }>;
}

function isGeminiEmbedResponse(json: unknown): json is GeminiEmbedResponse {
  if (!json || typeof json !== 'object') return false;
  const j = json as Record<string, unknown>;
  if (!j.embedding || typeof j.embedding !== 'object') return false;
  const emb = j.embedding as Record<string, unknown>;
  return Array.isArray(emb.values) && emb.values.length > 0;
}

function isGeminiBatchResponse(json: unknown, expectedCount: number): json is GeminiBatchResponse {
  if (!json || typeof json !== 'object') return false;
  const j = json as Record<string, unknown>;
  return Array.isArray(j.embeddings) && j.embeddings.length === expectedCount;
}

interface RetryContext {
  endpoint: string;
  tenantId: string;
}

async function callWithRetry<T>(
  url: string,
  // Accept a pre-built Headers object so the API key is never stored in any
  // plain object that could be accidentally serialized into logs.
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
        signal: AbortSignal.timeout(Math.max(PROVIDER_MIN_TIMEOUT_MS, Math.min(GEMINI_TIMEOUT_MS, remainingMs))),
      });
    } catch (err) {
      console.error(JSON.stringify({ event: 'provider.request_failed', endpoint: ctx.endpoint, tenant_id: ctx.tenantId, attempt: attempt + 1, error: err instanceof Error ? err.message : String(err) }));
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
      console.error(JSON.stringify({ event: 'provider.rate_limit', endpoint: ctx.endpoint, tenant_id: ctx.tenantId }));
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
      console.error(JSON.stringify({ event: 'provider.error', endpoint: ctx.endpoint, status: res.status, tenant_id: ctx.tenantId, response_preview: body.slice(0, GEMINI_ERROR_PREVIEW) }));
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
      console.error(JSON.stringify({ event: 'provider.invalid_response', endpoint: ctx.endpoint, tenant_id: ctx.tenantId, error: err instanceof Error ? err.message : String(err) }));
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

function embedEndpoint(): string {
  return `${GEMINI_API_BASE}/${GEMINI_MODEL}:embedContent`;
}

function batchEmbedEndpoint(): string {
  return `${GEMINI_API_BASE}/${GEMINI_MODEL}:batchEmbedContents`;
}

async function callEmbedContent(
  parts: GeminiPart[],
  apiKey: string,
  tenantId: string,
  endpoint: string,
  taskType?: string,
): Promise<number[]> {
  const body: GeminiEmbedRequest = { content: { parts }, output_dimensionality: GEMINI_OUTPUT_DIM };
  if (taskType) body.taskType = taskType;

  const headers = new Headers({ 'Content-Type': 'application/json', [GEMINI_AUTH_HEADER]: apiKey });

  return callWithRetry(
    embedEndpoint(),
    headers,
    body,
    (json) => {
      if (!isGeminiEmbedResponse(json)) throw new ProviderError(`${endpoint} returned invalid response`, 502);
      return json.embedding.values;
    },
    { endpoint, tenantId },
  );
}

async function callBatchEmbedContents(
  texts: string[],
  apiKey: string,
  tenantId: string,
  taskType: string,
  batchOffset = 0,
): Promise<number[][]> {
  if (texts.length === 0) throw new ProviderError('batch: empty input', 400);
  if (texts.length > 100) throw new ProviderError(`batch: size ${texts.length} exceeds maximum of 100`, 400);

  const body: GeminiBatchRequest = {
    requests: texts.map(text => ({
      model: `models/${GEMINI_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      output_dimensionality: GEMINI_OUTPUT_DIM,
    })),
  };

  const endpointLabel = `batch[${batchOffset}-${batchOffset + texts.length - 1}]`;

  const headers = new Headers({ 'Content-Type': 'application/json', [GEMINI_AUTH_HEADER]: apiKey });

  return callWithRetry(
    batchEmbedEndpoint(),
    headers,
    body,
    (json) => {
      if (!isGeminiBatchResponse(json, texts.length)) {
        const actual = Array.isArray((json as Record<string, unknown>)?.embeddings)
          ? ((json as Record<string, unknown>).embeddings as unknown[]).length
          : 'unknown';
        throw new ProviderError(`${endpointLabel} returned ${actual} embeddings, expected ${texts.length}`, 502);
      }
      return json.embeddings.map((e, i) => {
        if (!e?.values || !Array.isArray(e.values) || e.values.length === 0) {
          throw new ProviderError(`${endpointLabel} missing embedding at chunk index ${batchOffset + i}`, 502);
        }
        return e.values;
      });
    },
    { endpoint: endpointLabel, tenantId },
  );
}

export async function callTextProvider(
  input: string,
  apiKey: string,
  tenantId: string,
  taskType: string = GEMINI_DEFAULT_TASK_TYPE,
): Promise<TextProviderResponse> {
  const embedding = await callEmbedContent([{ text: input }], apiKey, tenantId, 'text', taskType);
  return { embedding };
}

export async function callImageProvider(
  image: { mime_type: string; data: string },
  apiKey: string,
  tenantId: string,
): Promise<number[]> {
  return callEmbedContent([{ inline_data: image }], apiKey, tenantId, 'image');
}

export async function callPdfProvider(
  pdfBase64: string,
  apiKey: string,
  tenantId: string,
): Promise<number[]> {
  return callEmbedContent([{ inline_data: { mime_type: 'application/pdf', data: pdfBase64 } }], apiKey, tenantId, 'pdf');
}

export async function callDocProvider(
  chunks: string[],
  apiKey: string,
  tenantId: string,
): Promise<DocProviderResponse> {
  const result: DocProviderResponse = {
    embeddings: Array.from({ length: chunks.length }, (_, i) => ({ index: i, embedding: [] as number[] })),
  };

  const batchStarts: number[] = [];
  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) batchStarts.push(i);

  for (let offset = 0; offset < batchStarts.length; offset += MAX_DOC_BATCH_CONCURRENCY) {
    await Promise.all(batchStarts.slice(offset, offset + MAX_DOC_BATCH_CONCURRENCY).map(async (i) => {
      const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
      const embeddings = await callBatchEmbedContents(batch, apiKey, tenantId, GEMINI_DEFAULT_TASK_TYPE, i);
      embeddings.forEach((embedding, j) => { result.embeddings[i + j] = { index: i + j, embedding }; });
    }));
  }

  return result;
}
