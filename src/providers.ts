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
  GEMINI_CHARS_PER_TOKEN,
} from './constants';

// ============================================================================
// PROVIDER CONFIGURATION — change only this file to swap providers
// ============================================================================

export interface ModelConfig {
  id: string;
  dimensions: number;
  costPer1M: number;
}

export interface GeminiConfig {
  name: string;
  baseUrl: string;
  /** REST endpoint for single embedContent */
  embedEndpoint: (model: string) => string;
  /** REST endpoint for batchEmbedContents */
  batchEmbedEndpoint: (model: string) => string;
  /** Model used for text, image, and PDF embeddings */
  model: ModelConfig;
  /** Task type sent for text/document retrieval */
  textTaskType: string;
  /** Output dimensionality (3072 = default, normalized; 1536/768 require client-side L2 norm) */
  outputDimensionality: number;
  /** Max images per single embedContent call */
  maxImagesPerRequest: number;
  /** Max PDF pages per single embedContent call */
  maxPdfPagesPerRequest: number;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Auth header name for API key */
  authHeader: string;
}

// All task types supported by gemini-embedding-2-preview.
// RETRIEVAL_DOCUMENT → content being indexed (stored in vector DB)
// RETRIEVAL_QUERY    → search query being issued against indexed content
// SEMANTIC_SIMILARITY, CLASSIFICATION, CLUSTERING, QUESTION_ANSWERING,
// FACT_VERIFICATION, CODE_RETRIEVAL_QUERY — see Gemini docs for details.
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

const GEMINI_AUTH_HEADER = 'x-goog-api-key' as const;

export const GEMINI: GeminiConfig = {
  name: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  embedEndpoint: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
  batchEmbedEndpoint: (model) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
  model: {
    id: 'gemini-embedding-2-preview',
    dimensions: 3072,
    costPer1M: 0.00,   // preview pricing — update when GA
  },
  // Default for document indexing. Use RETRIEVAL_QUERY when embedding search queries.
  textTaskType: 'RETRIEVAL_DOCUMENT',
  outputDimensionality: 3072,
  maxImagesPerRequest: 6,
  maxPdfPagesPerRequest: 6,
  timeoutMs: 30_000,
  authHeader: GEMINI_AUTH_HEADER,
};

// ============================================================================
// Shared response shapes
// ============================================================================

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

// ============================================================================
// Gemini REST types
// ============================================================================

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

// ============================================================================
// Retry-aware fetch
// ============================================================================

interface RetryContext {
  endpoint: string;
  tenantId: string;
  model: string;
}

async function callWithRetry<T>(
  url: string,
  apiKey: string,
  body: object,
  validate: (json: unknown) => T,
  ctx: RetryContext,
): Promise<T> {
  const deadline = Date.now() + PROVIDER_TOTAL_DEADLINE_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new ProviderError(`${ctx.endpoint} provider unreachable`, 502);

    let res: Response;
    try {
      const requestTimeoutMs = Math.max(PROVIDER_MIN_TIMEOUT_MS, Math.min(GEMINI.timeoutMs, remainingMs));
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [GEMINI.authHeader]: apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'provider.request_failed',
        provider: GEMINI.name,
        endpoint: ctx.endpoint,
        tenant_id: ctx.tenantId,
        model: ctx.model,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        const wouldExceedDeadline = Date.now() + delay > deadline;
        if (wouldExceedDeadline) throw new ProviderError(`${ctx.endpoint} provider timeout after ${attempt + 1} attempts`, 502);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new ProviderError(
        `${ctx.endpoint} provider unreachable: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSeconds = (() => {
        if (!retryAfterHeader) return undefined;
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds > 0) return seconds;
        // HTTP-date format (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
        const retryAt = Date.parse(retryAfterHeader);
        if (!Number.isNaN(retryAt)) {
          const delta = Math.ceil((retryAt - Date.now()) / 1000);
          return delta > 0 ? delta : undefined;
        }
        return undefined;
      })();
      if (attempt < MAX_RETRIES) {
        const retryMs = retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : PROVIDER_DEFAULT_RETRY_MS;
        if (Date.now() + retryMs > deadline) {
          throw new RateLimitError('Rate limit exceeded. Please wait before retrying.', retryAfterSeconds);
        }
        await new Promise(r => setTimeout(r, retryMs));
        continue;
      }
      console.error(JSON.stringify({ event: 'provider.rate_limit', provider: GEMINI.name, endpoint: ctx.endpoint, tenant_id: ctx.tenantId, model: ctx.model }));
      throw new RateLimitError(
        `Rate limit exceeded. ${retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? `Retry after ${retryAfterSeconds}s.` : 'Please wait before retrying.'}`,
        retryAfterSeconds,
      );
    }

    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      if (Date.now() + delay > deadline) throw new ProviderError(`${ctx.endpoint} provider error (${res.status})`, res.status);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      console.error(JSON.stringify({
        event: 'provider.error',
        provider: GEMINI.name,
        endpoint: ctx.endpoint,
        status: res.status,
        tenant_id: ctx.tenantId,
        model: ctx.model,
        response_bytes: errorBody.length,
      }));
      throw new ProviderError(`${ctx.endpoint} provider error (${res.status})`, res.status);
    }

    try {
      const json = await res.json();
      return validate(json);
    } catch (err) {
      if (err instanceof ProviderError || err instanceof RateLimitError) throw err;
      if (err instanceof SyntaxError || err instanceof TypeError ||
          (err && typeof err === 'object' && 'name' in err &&
           (err.name === 'SyntaxError' || err.name === 'TypeError'))) {
        throw new ProviderError(`${ctx.endpoint} provider returned invalid JSON`, 502);
      }
      console.error(JSON.stringify({ event: 'provider.invalid_response', provider: GEMINI.name, endpoint: ctx.endpoint, tenant_id: ctx.tenantId, model: ctx.model, error: err instanceof Error ? err.message : String(err) }));
      throw new ProviderError(`${ctx.endpoint} provider returned an invalid response`, 502);
    }
  }
  throw new ProviderError(`${ctx.endpoint} provider unreachable`, 502);
}

// ============================================================================
// Single embedContent call — used for image and PDF (one item per call)
// ============================================================================

async function callEmbedContent(
  parts: GeminiPart[],
  apiKey: string,
  tenantId: string,
  endpointLabel: string,
  taskType?: string,
): Promise<number[]> {
  const body: GeminiEmbedRequest = {
    content: { parts },
    output_dimensionality: GEMINI.outputDimensionality,
  };
  if (taskType) body.taskType = taskType;

  return callWithRetry(
    GEMINI.embedEndpoint(GEMINI.model.id),
    apiKey,
    body,
    (json) => {
      const j = json as GeminiEmbedResponse;
      if (!j?.embedding?.values || !Array.isArray(j.embedding.values) || j.embedding.values.length === 0) {
        throw new ProviderError(`Invalid response from ${GEMINI.name} ${endpointLabel}`, 502);
      }
      return j.embedding.values;
    },
    { endpoint: endpointLabel, tenantId, model: GEMINI.model.id },
  );
}

// ============================================================================
// batchEmbedContents — used for text chunks (multiple strings in one call)
// ============================================================================

async function callBatchEmbedContents(
  texts: string[],
  apiKey: string,
  tenantId: string,
  taskType: string,
): Promise<number[][]> {
  const body: GeminiBatchRequest = {
    requests: texts.map(text => ({
      model: `models/${GEMINI.model.id}`,
      content: { parts: [{ text }] },
      taskType,
      output_dimensionality: GEMINI.outputDimensionality,
    })),
  };

  return callWithRetry(
    GEMINI.batchEmbedEndpoint(GEMINI.model.id),
    apiKey,
    body,
    (json) => {
      const j = json as GeminiBatchResponse;
      if (!j?.embeddings || !Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) {
        throw new ProviderError(`Invalid batch response from ${GEMINI.name}`, 502);
      }
      return j.embeddings.map((e, i) => {
        if (!e?.values || !Array.isArray(e.values) || e.values.length === 0) {
          throw new ProviderError(`Missing embedding at index ${i} from ${GEMINI.name}`, 502);
        }
        return e.values;
      });
    },
    { endpoint: 'batch-text', tenantId, model: GEMINI.model.id },
  );
}

// ============================================================================
// Public provider functions
// ============================================================================

/** Embed one or more text strings. */
export async function callTextProvider(
  inputs: string[],
  apiKey: string,
  tenantId: string,
  taskType: string = GEMINI.textTaskType,
): Promise<TextProviderResponse> {
  const embeddings = await callBatchEmbedContents(inputs, apiKey, tenantId, taskType);
  const estimatedTokens = inputs.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / GEMINI_CHARS_PER_TOKEN)), 0);
  return {
    data: embeddings.map(embedding => ({ embedding })),
    usage: { total_tokens: estimatedTokens },
    _model: GEMINI.model.id,
    _provider: GEMINI.name,
  };
}

/** Embed a single image (base64 or URL fetched by caller). */
export async function callImageProvider(
  parts: GeminiPart[],
  apiKey: string,
  tenantId: string,
): Promise<ImageProviderResponse> {
  // Each image is a separate embedContent call; Gemini returns one embedding per call.
  // For batch image requests the caller passes one part[] per image.
  const embedding = await callEmbedContent(parts, apiKey, tenantId, 'image');
  return {
    data: [{ embedding, index: 0 }],
    usage: { total_tokens: 0 },
  };
}

/** Embed a batch of images (one embedContent call per image, concurrently). */
export async function callImageBatchProvider(
  itemParts: GeminiPart[][],
  apiKey: string,
  tenantId: string,
): Promise<ImageProviderResponse> {
  const results: { embedding: number[]; index: number }[] = [];
  for (let offset = 0; offset < itemParts.length; offset += GEMINI.maxImagesPerRequest) {
    const window = itemParts.slice(offset, offset + GEMINI.maxImagesPerRequest);
    const windowResults = await Promise.all(
      window.map((parts, i) =>
        callEmbedContent(parts, apiKey, tenantId, 'image').then(embedding => ({ embedding, index: offset + i }))
      )
    );
    results.push(...windowResults);
  }
  return {
    data: results,
    usage: { total_tokens: 0 },
  };
}

/** Embed a PDF document directly (inline_data with application/pdf). */
export async function callPdfProvider(
  pdfBase64: string,
  apiKey: string,
  tenantId: string,
): Promise<number[]> {
  return callEmbedContent(
    [{ inline_data: { mime_type: 'application/pdf', data: pdfBase64 } }],
    apiKey,
    tenantId,
    'pdf',
  );
}

/** Embed document text chunks via batchEmbedContents. */
export async function callDocProvider(
  chunks: string[],
  apiKey: string,
  tenantId: string,
): Promise<DocProviderResponse> {
  const result: DocProviderResponse = {
    embeddings: new Array(chunks.length) as { index: number; embedding: number[] }[],
    total_tokens: 0,
    _model: GEMINI.model.id,
    _provider: GEMINI.name,
  };

  const batchStarts: number[] = [];
  for (let i = 0; i < chunks.length; i += DOC_BATCH_SIZE) batchStarts.push(i);

  // Process in concurrency-limited windows; write directly into pre-allocated slots
  // to avoid a second pass and eliminate the sort-then-flatten allocation.
  for (let offset = 0; offset < batchStarts.length; offset += MAX_DOC_BATCH_CONCURRENCY) {
    const window = batchStarts.slice(offset, offset + MAX_DOC_BATCH_CONCURRENCY);
    await Promise.all(window.map(async (i) => {
      const batch = chunks.slice(i, i + DOC_BATCH_SIZE);
      const embeddings = await callBatchEmbedContents(batch, apiKey, tenantId, GEMINI.textTaskType);
      embeddings.forEach((embedding, j) => {
        result.embeddings[i + j] = { index: i + j, embedding };
      });
    }));
  }

  return result;
}

// Re-export GeminiPart so handlers can use it without importing from providers internals
export type { GeminiPart };
