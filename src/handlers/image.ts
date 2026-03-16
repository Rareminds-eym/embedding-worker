/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError } from '../types';
import { jsonOk } from '../utils/response';
import { resolveImageModel, callImageProvider, VoyageRequestItem } from '../providers';
import {
  MAX_IMAGE_BATCH_SIZE,
  MAX_IMAGE_REQUEST_BODY_SIZE,
  ALLOWED_IMAGE_MEDIA_TYPES,
  ERROR_CODES,
} from '../constants';

// ── Types ──────────────────────────────────────────────────

type AllowedMediaType = typeof ALLOWED_IMAGE_MEDIA_TYPES[number];

interface ImageInputUrl {
  type: 'url';
  data: string;
}

interface ImageInputBase64 {
  type: 'base64';
  data: string;
  mediaType: AllowedMediaType;
}

type ImageInput = ImageInputUrl | ImageInputBase64;

// ── Normalize input ────────────────────────────────────────

function normalizeInput(input: unknown): ImageInput[] {
  const toItem = (item: unknown): ImageInput => {
    if (typeof item !== 'object' || item === null) {
      throw new ValidationError(
        'Each input item must be an object with type and data fields',
        ERROR_CODES.INVALID_INPUT
      );
    }
    const obj = item as Record<string, unknown>;

    if (obj.type !== 'url' && obj.type !== 'base64') {
      throw new ValidationError(
        'input.type must be "url" or "base64"',
        ERROR_CODES.INVALID_INPUT
      );
    }
    if (typeof obj.data !== 'string' || obj.data.trim().length === 0) {
      throw new ValidationError('input.data must be a non-empty string', ERROR_CODES.INVALID_INPUT);
    }

    if (obj.type === 'url') {
      try { new URL(obj.data as string); } catch {
        throw new ValidationError('input.data must be a valid URL', ERROR_CODES.INVALID_INPUT);
      }
      return { type: 'url', data: obj.data as string };
    }

    // base64
    if (!obj.mediaType || !(ALLOWED_IMAGE_MEDIA_TYPES as readonly string[]).includes(obj.mediaType as string)) {
      throw new ValidationError(
        `input.mediaType must be one of: ${ALLOWED_IMAGE_MEDIA_TYPES.join(', ')}`,
        ERROR_CODES.INVALID_INPUT
      );
    }
    return { type: 'base64', data: obj.data as string, mediaType: obj.mediaType as AllowedMediaType };
  };

  if (Array.isArray(input)) return input.map(toItem);
  return [toItem(input)];
}

// ── Build Voyage request payload ───────────────────────────

function buildVoyageInputs(items: ImageInput[]): VoyageRequestItem[] {
  return items.map(item => {
    if (item.type === 'url') {
      return { content: [{ type: 'image_url' as const, image_url: item.data }] };
    }
    // Voyage requires data URL format: "data:<mediatype>;base64,<data>"
    const dataUrl = `data:${item.mediaType};base64,${item.data}`;
    return {
      content: [{ type: 'image_base64' as const, image_base64: dataUrl }],
    };
  });
}

// ── Handler ────────────────────────────────────────────────

export async function handleImageEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  const bodyText = await request.text().catch(() => '');
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
    throw new ValidationError(
      `Batch size exceeds maximum of ${MAX_IMAGE_BATCH_SIZE}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const modelConfig = resolveImageModel(undefined);
  const voyageInputs = buildVoyageInputs(inputs);
  const result = await callImageProvider(voyageInputs, modelConfig.id, env.VOYAGE_API_KEY, ctx.tenantId);

  const totalTokens = result.usage?.total_tokens ?? 0;
  const estimatedCost = ((totalTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6);

  // Return all embeddings for batch, single embedding for single input
  const embeddings = result.data.map(item => ({
    index: item.index,
    embedding: item.embedding,
    dimensions: item.embedding.length,
  }));

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
    latency_ms: Date.now() - ctx.startTime,
  }, 200, request, env);
}
