/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, EmbeddingItem } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { callImageBatchProvider, GEMINI } from '../providers';
import type { GeminiPart } from '../providers';
import {
  MAX_IMAGE_BATCH_SIZE,
  MAX_IMAGE_REQUEST_BODY_SIZE,
  MAX_IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_FETCH_SIZE,
  ALLOWED_IMAGE_MEDIA_TYPES,
  ERROR_CODES,
} from '../constants';
import { checkRateLimit } from '../utils/ratelimit';

type AllowedMediaType = typeof ALLOWED_IMAGE_MEDIA_TYPES[number];

// Gemini embedding-2-preview supports PNG and JPEG only
const GEMINI_ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

// SSRF guard — blocks private/loopback ranges before we fetch the URL
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.\d+\.\d+\.\d+|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|metadata\.google\.internal|169\.254\.169\.254|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|::1$|::ffff:|\[::1\]|\[::ffff:|\[f[cd][0-9a-f]{2}:|\[fe80:)/i;

interface ImageInputUrl    { type: 'url';    data: string; }
interface ImageInputBase64 { type: 'base64'; data: string; mediaType: AllowedMediaType; }
type ImageInput = ImageInputUrl | ImageInputBase64;

function validateUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError('input.data must be a valid URL', ERROR_CODES.INVALID_INPUT);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('input.data URL must use http or https scheme', ERROR_CODES.INVALID_INPUT);
  }
  if (
    PRIVATE_HOST.test(parsed.hostname) ||
    parsed.hostname.endsWith('.internal') ||
    parsed.hostname.endsWith('.local') ||
    parsed.hostname === '0'
  ) {
    throw new ValidationError('Private or internal URLs are not permitted', ERROR_CODES.INVALID_INPUT);
  }
  return raw;
}

function normalizeInput(input: unknown): ImageInput[] {
  const toItem = (item: unknown): ImageInput => {
    if (typeof item !== 'object' || item === null) {
      throw new ValidationError('Each input item must be an object with type and data fields', ERROR_CODES.INVALID_INPUT);
    }
    const obj = item as Record<string, unknown>;

    if (obj.type !== 'url' && obj.type !== 'base64') {
      throw new ValidationError('input.type must be "url" or "base64"', ERROR_CODES.INVALID_INPUT);
    }
    if (typeof obj.data !== 'string' || obj.data.trim().length === 0) {
      throw new ValidationError('input.data must be a non-empty string', ERROR_CODES.INVALID_INPUT);
    }

    if (obj.type === 'url') {
      return { type: 'url', data: validateUrl(obj.data as string) };
    }

    if (!obj.mediaType || !(ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(obj.mediaType as string)) {
      throw new ValidationError(
        `input.mediaType must be one of: ${ALLOWED_IMAGE_MEDIA_TYPES.join(', ')}`,
        ERROR_CODES.INVALID_INPUT
      );
    }
    return { type: 'base64', data: obj.data as string, mediaType: obj.mediaType as AllowedMediaType };
  };

  if (Array.isArray(input)) {
    if (input.length === 0) throw new ValidationError('input array must not be empty', ERROR_CODES.INVALID_INPUT);
    return input.map(toItem);
  }
  return [toItem(input)];
}

/** Fetch a URL and return { base64, mimeType }. Enforces Gemini-supported types. */
async function fetchImageAsBase64(url: string, tenantId: string): Promise<{ data: string; mediaType: AllowedMediaType }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(MAX_IMAGE_FETCH_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'image_fetch.error', tenant_id: tenantId, url, error: msg }));
    throw new WorkerError('Failed to fetch image URL', ERROR_CODES.INTERNAL_ERROR, 502);
  }

  if (!res.ok) {
    throw new ValidationError(`Image URL returned HTTP ${res.status}`, ERROR_CODES.INVALID_INPUT);
  }

  const contentLength = res.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_FETCH_SIZE) {
    throw new ValidationError(`Image exceeds maximum size of ${MAX_IMAGE_FETCH_SIZE} bytes`, ERROR_CODES.INVALID_INPUT);
  }

  const contentType = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  // Normalise common aliases
  const mimeType = contentType === 'image/jpg' ? 'image/jpeg' : contentType;

  if (!GEMINI_ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new ValidationError(
      `Image URL content type "${mimeType}" is not supported. Gemini accepts image/png and image/jpeg.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_FETCH_SIZE) {
    throw new ValidationError(`Image exceeds maximum size of ${MAX_IMAGE_FETCH_SIZE} bytes`, ERROR_CODES.INVALID_INPUT);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000; // 32KB chunks to avoid call stack limits
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
  }
  const base64 = btoa(binary);
  return { data: base64, mediaType: mimeType as AllowedMediaType };
}

async function buildGeminiParts(items: ImageInput[], tenantId: string): Promise<GeminiPart[][]> {
  return Promise.all(items.map(async (item) => {
    if (item.type === 'url') {
      const { data, mediaType } = await fetchImageAsBase64(item.data, tenantId);
      return [{ inline_data: { mime_type: mediaType, data } }];
    }
    // Validate Gemini-supported type for base64 inputs
    if (!GEMINI_ALLOWED_IMAGE_TYPES.has(item.mediaType)) {
      throw new ValidationError(
        `mediaType "${item.mediaType}" is not supported. Gemini accepts image/png and image/jpeg.`,
        ERROR_CODES.INVALID_INPUT
      );
    }
    return [{ inline_data: { mime_type: item.mediaType, data: item.data } }];
  }));
}

export async function handleImageEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  const bodyText = await request.text().catch((err) => {
    console.error(JSON.stringify({ event: 'body_read_error', endpoint: 'image', tenant_id: ctx.tenantId, error: err instanceof Error ? err.message : String(err) }));
    throw new WorkerError('Failed to read request body', ERROR_CODES.INTERNAL_ERROR, 500);
  });
  if (bodyText.length > MAX_IMAGE_REQUEST_BODY_SIZE) {
    throw new ValidationError('Request body too large', ERROR_CODES.INVALID_INPUT);
  }

  const body = (() => {
    try { return JSON.parse(bodyText) as Record<string, unknown>; }
    catch { return null; }
  })();

  if (!body || !('input' in body)) {
    throw new ValidationError('Missing required field: input', ERROR_CODES.INVALID_INPUT);
  }

  // Validate and normalise inputs (URL SSRF check happens here, no network yet)
  const inputs = normalizeInput(body.input);

  // Batch size check before any network I/O
  if (inputs.length > MAX_IMAGE_BATCH_SIZE) {
    throw new ValidationError(`Batch size exceeds maximum of ${MAX_IMAGE_BATCH_SIZE}`, ERROR_CODES.INVALID_INPUT);
  }
  if (inputs.length > GEMINI.maxImagesPerRequest) {
    throw new ValidationError(
      `Batch size exceeds Gemini limit of ${GEMINI.maxImagesPerRequest} images per request`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  if (typeof body.model === 'string') {
    throw new ValidationError(
      `model parameter is not supported. Image embeddings always use ${GEMINI.model.id}.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  await checkRateLimit(ctx.tenantId, 'image', env);

  // Resolve URLs → base64 (concurrent, after rate-limit check)
  const itemParts = await buildGeminiParts(inputs, ctx.tenantId);
  const result = await callImageBatchProvider(itemParts, env.GEMINI_API_KEY, ctx.tenantId);

  const embeddings: EmbeddingItem[] = result.data.map(item => ({
    index: item.index,
    embedding: item.embedding,
    dimensions: item.embedding.length,
  }));

  const latency_ms = Date.now() - ctx.startTime;
  console.log(JSON.stringify({ event: 'embed.success', endpoint: 'image', tenant_id: ctx.tenantId, latency_ms, model: GEMINI.model.id, count: embeddings.length }));

  return jsonOk({
    success: true,
    ...(embeddings.length === 1
      ? { embedding: embeddings[0].embedding, dimensions: embeddings[0].dimensions }
      : { embeddings }
    ),
    model: GEMINI.model.id,
    usage: { estimated_cost_usd: 0 },
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
