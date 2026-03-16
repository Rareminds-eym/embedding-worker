/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { resolveModel, callTextProvider } from '../providers';
import {
  MAX_DOC_REQUEST_BODY_SIZE,
  MAX_INPUT_CHARS,
  ALLOWED_DOC_TYPES,
  ERROR_CODES,
} from '../constants';
import type { AllowedDocMimeType } from '../constants';

// ── Handler ────────────────────────────────────────────────

export async function handleDocEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  const bodyText = await request.text().catch(() => '');
  if (bodyText.length > MAX_DOC_REQUEST_BODY_SIZE) {
    throw new ValidationError('Request body too large', ERROR_CODES.INVALID_INPUT);
  }

  const body = (() => {
    try { return JSON.parse(bodyText) as Record<string, unknown>; }
    catch { return null; }
  })();

  if (!body || !('input' in body)) {
    throw new ValidationError('Missing required field: input', ERROR_CODES.INVALID_INPUT);
  }

  const input = body.input as Record<string, unknown>;

  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('input must be an object', ERROR_CODES.INVALID_INPUT);
  }

  // Validate mimeType
  const mimeType = input.mimeType as string;
  if (!mimeType || !(mimeType in ALLOWED_DOC_TYPES)) {
    throw new ValidationError(
      `input.mimeType must be one of: ${Object.keys(ALLOWED_DOC_TYPES).join(', ')}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  // Validate data (base64)
  if (typeof input.data !== 'string' || input.data.trim().length === 0) {
    throw new ValidationError('input.data must be a non-empty base64 string', ERROR_CODES.INVALID_INPUT);
  }

  // Validate filename (optional, used for toMarkdown)
  const docType = ALLOWED_DOC_TYPES[mimeType as AllowedDocMimeType];
  const filename = typeof input.filename === 'string' && input.filename.trim().length > 0
    ? input.filename.trim()
    : `document.${docType.ext}`;

  // Decode base64 → binary
  let binaryData: Uint8Array;
  try {
    const binaryStr = atob(input.data as string);
    binaryData = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      binaryData[i] = binaryStr.charCodeAt(i);
    }
  } catch {
    throw new ValidationError('input.data is not valid base64', ERROR_CODES.INVALID_INPUT);
  }

  // Convert doc → markdown via Cloudflare Workers AI
  const blob = new Blob([binaryData], { type: mimeType });
  let conversionResult: { name: string; format: string; data?: string; error?: string };

  try {
    const results = await env.AI.toMarkdown({ name: filename, blob });
    // toMarkdown returns array when given array, single object when given single object
    conversionResult = Array.isArray(results) ? results[0] : results;
  } catch (err) {
    console.error(JSON.stringify({
      event: 'toMarkdown.error',
      tenant_id: ctx.tenantId,
      filename,
      mimeType,
      error: err instanceof Error ? err.message : String(err),
    }));
    throw new WorkerError('Document conversion failed', ERROR_CODES.INTERNAL_ERROR, 500);
  }

  if (conversionResult.format === 'error' || !conversionResult.data) {
    throw new ValidationError(
      `Document conversion failed: ${conversionResult.error ?? 'unknown error'}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  // Truncate to model's max input chars
  const markdown = conversionResult.data.slice(0, MAX_INPUT_CHARS);

  if (markdown.trim().length === 0) {
    throw new ValidationError('Document appears to be empty or contains no extractable text', ERROR_CODES.INVALID_INPUT);
  }

  // Embed the extracted markdown text
  const modelConfig = resolveModel(undefined);
  const result = await callTextProvider([markdown], modelConfig.id, env.VOYAGE_API_KEY, ctx.tenantId);

  const totalTokens = result.usage?.total_tokens ?? 0;
  const estimatedCost = ((totalTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6);

  return jsonOk({
    success: true,
    embedding: result.data[0].embedding,
    model: modelConfig.id,
    dimensions: result.data[0].embedding.length,
    document: {
      filename,
      mimeType,
      type: docType.label,
      extracted_chars: markdown.length,
      truncated: conversionResult.data.length > MAX_INPUT_CHARS,
    },
    usage: {
      total_tokens: totalTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms: Date.now() - ctx.startTime,
  }, 200, request, env);
}
