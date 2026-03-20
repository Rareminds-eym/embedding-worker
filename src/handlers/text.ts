/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { callTextProvider, OPENAI } from '../providers';
import { ERROR_CODES, TEXT_MAX_CHARS, MAX_REQUEST_BODY_SIZE } from '../constants';
import { checkRateLimit } from '../utils/ratelimit';

const SKIP_KEYS = new Set([
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
  'deleted_at', 'deletedAt', 'embedding',
]);

// Case-sensitive: intentionally matches lowercase keys only.
// Mixed-case variants (e.g. ID, UUID) are not skipped — only exact lowercase forms are.
function shouldSkip(key: string): boolean {
  return SKIP_KEYS.has(key) || /^_?id$|_id$|^id_|^uuid$|^guid$/.test(key);
}

function tryParseJsonString(v: string): unknown | null {
  const trimmed = v.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try { return JSON.parse(v); } catch { return null; }
}

function extractText(value: unknown, key?: string, depth = 0, budget = { left: TEXT_MAX_CHARS }): string {
  if (budget.left <= 0 || value === null || value === undefined) return '';
  if (depth > 10) return '';

  if (typeof value === 'string') {
    const v = value.trim();
    if (!v || v === '[]' || v === '{}') return '';
    const parsed = tryParseJsonString(v);
    if (parsed !== null) return extractText(parsed, key, depth + 1, budget);
    const out = key ? `${key}: ${v}` : v;
    budget.left -= out.length;
    return out;
  }

  if (typeof value === 'number') {
    const out = key ? `${key}: ${value}` : String(value);
    budget.left -= out.length;
    return out;
  }

  if (typeof value === 'boolean') {
    if (!value) return '';
    const out = key ? `${key}: ${value}` : String(value);
    budget.left -= out.length;
    return out;
  }

  if (Array.isArray(value)) {
    const items = value
      .map(item => extractText(item, undefined, depth + 1, budget))
      .filter(Boolean)
      .join(', ');
    return items ? (key ? `${key}: ${items}` : items) : '';
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !shouldSkip(k))
      .map(([k, v]) => extractText(v, k, depth + 1, budget))
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

  if (Array.isArray(body.input)) {
    if (body.input.length === 0) {
      throw new ValidationError('Input array must not be empty', ERROR_CODES.INVALID_INPUT);
    }
    const parts = (body.input as unknown[]).map(item => normalizeInput(item)).filter(Boolean);
    if (parts.length === 0) {
      throw new ValidationError('Input array produced no embeddable text', ERROR_CODES.INVALID_INPUT);
    }
    body.input = parts.join(' ');
  }

  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey) {
    throw new ValidationError(
      `model parameter is not supported on this endpoint. Text embeddings always use ${OPENAI.defaultModel}.`,
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

  if (!env.OPENAI_API_KEY) {
    throw new WorkerError('OPENAI_API_KEY not configured', ERROR_CODES.INTERNAL_ERROR, 503);
  }

  await checkRateLimit(ctx.tenantId, 'text', env);
  const modelConfig = OPENAI.model;
  const result = await callTextProvider([text], env.OPENAI_API_KEY, ctx.tenantId);
  const embedding = result.data[0].embedding;
  const promptTokens = result.usage?.total_tokens ?? 0;
  const estimatedCost = parseFloat(((promptTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6));

  const latency_ms = Date.now() - ctx.startTime;
  console.log(JSON.stringify({ event: 'embed.success', endpoint: 'text', tenant_id: ctx.tenantId, tokens: promptTokens, latency_ms, model: OPENAI.defaultModel }));

  return jsonOk({
    success: true,
    embedding,
    model: OPENAI.defaultModel,
    dimensions: embedding.length,
    usage: {
      total_tokens: promptTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
