/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError } from '../types';
import { jsonOk } from '../utils/response';
import { resolveModel, callTextProvider, VOYAGE } from '../providers';
import { MAX_INPUT_CHARS, MAX_REQUEST_BODY_SIZE, ERROR_CODES } from '../constants';

const SKIP_KEYS = new Set([
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
  'deleted_at', 'deletedAt', 'embedding',
]);

function shouldSkip(key: string): boolean {
  return SKIP_KEYS.has(key) || /id/i.test(key);
}

function tryParseJsonString(v: string): unknown | null {
  const trimmed = v.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try { return JSON.parse(v); }
  catch { return null; }
}

function extractText(value: unknown, key?: string): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'string') {
    const v = value.trim();
    if (!v || v === '[]' || v === '{}') return '';
    const parsed = tryParseJsonString(v);
    if (parsed !== null) return extractText(parsed, key);
    return key ? `${key}: ${v}` : v;
  }

  if (typeof value === 'number') {
    return key ? `${key}: ${value}` : String(value);
  }

  if (typeof value === 'boolean') {
    if (!value) return '';
    return key ? `${key}: ${value}` : String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(item => extractText(item)).filter(Boolean).join(', ');
    return items ? (key ? `${key}: ${items}` : items) : '';
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !shouldSkip(k))
      .map(([k, v]) => extractText(v, k))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

const SAFE_CHAR_LIMIT = 24_000;

function normalizeInput(input: unknown): { text: string; truncated: boolean } {
  if (typeof input === 'string') return { text: input.trim(), truncated: false };
  const text = extractText(input).replace(/\s+/g, ' ').trim();
  if (text.length > SAFE_CHAR_LIMIT) {
    return { text: text.slice(0, SAFE_CHAR_LIMIT).trimEnd(), truncated: true };
  }
  return { text, truncated: false };
}

export async function handleTextEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  const bodyText = await request.text().catch(() => '');
  if (bodyText.length > MAX_REQUEST_BODY_SIZE) {
    throw new ValidationError('Request body too large', ERROR_CODES.INVALID_INPUT);
  }

  const body = (() => {
    try { return JSON.parse(bodyText) as Record<string, unknown>; }
    catch { return null; }
  })();

  if (!body || !('input' in body)) {
    throw new ValidationError('Missing required field: input', ERROR_CODES.INVALID_INPUT);
  }

  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && !VOYAGE.textModelKeys.includes(modelKey)) {
    throw new ValidationError(
      `Invalid model. Must be one of: ${VOYAGE.textModelKeys.join(', ')}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const { text: input, truncated } = normalizeInput(body.input);

  if (input.trim().length === 0) {
    throw new ValidationError('Input cannot be empty', ERROR_CODES.INVALID_INPUT);
  }

  if (input.length > MAX_INPUT_CHARS) {
    throw new ValidationError(
      `Input exceeds maximum of ${MAX_INPUT_CHARS} characters`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  if (env.ENVIRONMENT !== 'production') {
    console.debug(`[text-embed] tenant=${ctx.tenantId} req=${ctx.requestId} chars=${input.length}`);
  }

  const modelConfig = resolveModel(modelKey);
  const result = await callTextProvider([input], modelConfig.id, env.VOYAGE_API_KEY, ctx.tenantId);
  const embedding: number[] = result.data[0].embedding;
  const promptTokens = result.usage?.total_tokens ?? 0;
  const estimatedCost = ((promptTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6);

  return jsonOk({
    success: true,
    embedding,
    model: modelConfig.id,
    dimensions: embedding.length,
    ...(truncated && { truncated: true }),
    usage: {
      total_tokens: promptTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms: Date.now() - ctx.startTime,
  }, 200, request, env);
}
