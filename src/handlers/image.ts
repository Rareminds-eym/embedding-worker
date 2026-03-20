/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, EmbeddingItem } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { resolveImageModel, callImageProvider, VoyageRequestItem, VOYAGE } from '../providers';
import {
  MAX_IMAGE_BATCH_SIZE,
  MAX_IMAGE_REQUEST_BODY_SIZE,
  ALLOWED_IMAGE_MEDIA_TYPES,
  ERROR_CODES,
} from '../constants';
import { checkRateLimit } from '../utils/ratelimit';

type AllowedMediaType = typeof ALLOWED_IMAGE_MEDIA_TYPES[number];

interface ImageInputUrl { type: 'url'; data: string; }
interface ImageInputBase64 { type: 'base64'; data: string; mediaType: AllowedMediaType; }
type ImageInput = ImageInputUrl | ImageInputBase64;

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
      try {
        const parsed = new URL(obj.data as string);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new ValidationError('input.data URL must use http or https scheme', ERROR_CODES.INVALID_INPUT);
        }
        const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.\d+\.\d+\.\d+|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|metadata\.google|fc00|fd00|fe80|\[::1\]|\[::ffff:)/i;
        if (
          PRIVATE_HOST.test(parsed.hostname) ||
          parsed.hostname.endsWith('.internal') ||
          parsed.hostname.endsWith('.local')
        ) {
          throw new ValidationError('Private or internal URLs are not permitted', ERROR_CODES.INVALID_INPUT);
        }
      } catch (e) {
        if (e instanceof ValidationError) throw e;
        throw new ValidationError('input.data must be a valid URL', ERROR_CODES.INVALID_INPUT);
      }
      return { type: 'url', data: obj.data as string };
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

function buildVoyageInputs(items: ImageInput[]): VoyageRequestItem[] {
  return items.map(item => {
    if (item.type === 'url') {
      return { content: [{ type: 'image_url' as const, image_url: item.data }] };
    }
    return { content: [{ type: 'image_base64' as const, image_base64: `data:${item.mediaType};base64,${item.data}` }] };
  });
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

  const inputs = normalizeInput(body.input);
  if (inputs.length > MAX_IMAGE_BATCH_SIZE) {
    throw new ValidationError(`Batch size exceeds maximum of ${MAX_IMAGE_BATCH_SIZE}`, ERROR_CODES.INVALID_INPUT);
  }

  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && !VOYAGE.imageModelKeys.includes(modelKey)) {
    throw new ValidationError(
      `Invalid model. Must be one of: ${VOYAGE.imageModelKeys.join(', ')}`,
      ERROR_CODES.INVALID_INPUT
    );
  }
  const modelConfig = resolveImageModel(modelKey);
  await checkRateLimit(ctx.tenantId, 'image', env);
  const result = await callImageProvider(buildVoyageInputs(inputs), modelConfig.id, env.VOYAGE_API_KEY, ctx.tenantId);
  const totalTokens = result.usage?.total_tokens ?? 0;
  const estimatedCost = ((totalTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6);

  const embeddings: EmbeddingItem[] = result.data.map(item => ({
    index: item.index,
    embedding: item.embedding,
    dimensions: item.embedding.length,
  }));

  const latency_ms = Date.now() - ctx.startTime;
  console.error(JSON.stringify({ event: 'embed.success', endpoint: 'image', tenant_id: ctx.tenantId, tokens: totalTokens, latency_ms, model: modelConfig.id, count: embeddings.length }));

  return jsonOk({
    success: true,
    ...(embeddings.length === 1
      ? { embedding: embeddings[0].embedding, dimensions: embeddings[0].dimensions }
      : { embeddings }
    ),
    model: modelConfig.id,
    usage: {
      total_tokens: totalTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
