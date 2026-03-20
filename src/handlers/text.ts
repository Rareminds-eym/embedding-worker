/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { resolveModel, callTextProvider, VOYAGE } from '../providers';
import { ERROR_CODES, TEXT_MAX_CHARS } from '../constants';
import { checkRateLimit } from '../utils/ratelimit';

const SKIP_KEYS = new Set([
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
  'deleted_at', 'deletedAt', 'embedding',
]);

function shouldSkip(key: string): boolean {
  return SKIP_KEYS.has(key) || /^_?id$|_id$|^id_|^uuid$|^guid$/i.test(key);
}

function tryParseJsonString(v: string): unknown | null {
  const trimmed = v.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try { return JSON.parse(v); } catch { return null; }
}

function extractText(value: unknown, key?: string, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (depth > 10) return '';

  if (typeof value === 'string') {
    const v = value.trim();
    if (!v || v === '[]' || v === '{}') return '';
    const parsed = tryParseJsonString(v);
    if (parsed !== null) return extractText(parsed, key, depth + 1);
    return key ? `${key}: ${v}` : v;
  }

  if (typeof value === 'number') return key ? `${key}: ${value}` : String(value);

  if (typeof value === 'boolean') {
    // false intentionally omitted — carries no semantic signal for embeddings
    if (!value) return '';
    return key ? `${key}: ${value}` : String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(item => extractText(item, undefined, depth + 1)).filter(Boolean).join(', ');
    return items ? (key ? `${key}: ${items}` : items) : '';
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !shouldSkip(k))
      .map(([k, v]) => extractText(v, k, depth + 1))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function normalizeInput(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  return extractText(input).replace(/\s+/g, ' ').trim();
}

export async function handleTextEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  const bodyText = await request.text().catch((err) => {
    console.error(JSON.stringify({ event: 'body_read_error', endpoint: 'text', tenant_id: ctx.tenantId, error: err instanceof Error ? err.message : String(err) }));
    throw new WorkerError('Failed to read request body', ERROR_CODES.INTERNAL_ERROR, 500);
  });

  const body = (() => {
    try { return JSON.parse(bodyText) as Record<string, unknown>; }
    catch { return null; }
  })();

  if (!body || !('input' in body)) {
    throw new ValidationError('Missing required field: input', ERROR_CODES.INVALID_INPUT);
  }

  if (Array.isArray(body.input)) {
    if (body.input.length === 0) {
      throw new ValidationError('Input array must not be empty', ERROR_CODES.INVALID_INPUT);
    }
    // Normalize each item (string or object) then join into one string — single Voyage call
    const parts = (body.input as unknown[]).map(item => normalizeInput(item)).filter(Boolean);
    if (parts.length === 0) {
      throw new ValidationError('Input array produced no embeddable text', ERROR_CODES.INVALID_INPUT);
    }
    body.input = parts.join(' ');
  }

  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && !VOYAGE.textModelKeys.includes(modelKey)) {
    throw new ValidationError(
      `Invalid model. Must be one of: ${VOYAGE.textModelKeys.join(', ')}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const text = normalizeInput(body.input);

  if (text.length === 0) {
    throw new ValidationError('Input cannot be empty', ERROR_CODES.INVALID_INPUT);
  }

  if (text.length > TEXT_MAX_CHARS) {
    throw new ValidationError(
      `Input exceeds maximum of ${TEXT_MAX_CHARS} characters (~30,000 tokens). Truncate or summarize your input.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  await checkRateLimit(ctx.tenantId, 'text', env);
  const modelConfig = resolveModel(modelKey);
  const result = await callTextProvider([text], modelConfig.id, env.VOYAGE_API_KEY, env.OPENAI_API_KEY, ctx.tenantId);
  const embedding = result.data[0].embedding;
  const promptTokens = result.usage?.total_tokens ?? 0;
  const actualModel = result._model;
  const actualCostPer1M = result._provider === 'openai' ? 0.02 : modelConfig.costPer1M;
  const estimatedCost = ((promptTokens / 1_000_000) * actualCostPer1M).toFixed(6);

  const latency_ms = Date.now() - ctx.startTime;
  console.error(JSON.stringify({ event: 'embed.success', endpoint: 'text', tenant_id: ctx.tenantId, tokens: promptTokens, latency_ms, model: actualModel, ...(result._provider !== 'voyage' && { fallback_provider: result._provider }) }));

  return jsonOk({
    success: true,
    embedding,
    model: actualModel,
    ...(result._provider !== 'voyage' && { fallback_provider: result._provider }),
    dimensions: embedding.length,
    usage: {
      total_tokens: promptTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
