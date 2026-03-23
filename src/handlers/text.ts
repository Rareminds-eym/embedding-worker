/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { callTextProvider, GEMINI, GEMINI_TASK_TYPES } from '../providers';
import type { GeminiTaskType } from '../providers';
import { ERROR_CODES, TEXT_MAX_CHARS, MAX_REQUEST_BODY_SIZE } from '../constants';
import { checkRateLimit } from '../utils/ratelimit';

const SKIP_KEYS = new Set([
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
  'deleted_at', 'deletedAt', 'embedding',
]);

const ID_PATTERN = /^(_?id|.*_id|id_.*|uuid|guid)$/i;

function shouldSkip(key: string): boolean {
  if (key.length > 50) return true;
  return SKIP_KEYS.has(key) || ID_PATTERN.test(key);
}

function tryParseJsonString(v: string): unknown | null {
  const trimmed = v.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try { return JSON.parse(v); } catch { return null; }
}

function extractText(value: unknown, key?: string, depth = 0, budget = { left: TEXT_MAX_CHARS }, seen = new WeakSet()): string {
  if (budget.left <= 0 || value === null || value === undefined) return '';
  if (depth > 10) return '';

  if (typeof value === 'object' && value !== null) {
    // Check for circular reference before any mutation
    if (seen.has(value)) return '';
    
    // Truncate large arrays before registering in the seen-set to avoid
    // holding a reference to the full array for the lifetime of the traversal.
    if (Array.isArray(value) && value.length > 1000) {
      seen.add(value as object); // Register original first
      value = value.slice(0, 1000) as unknown[];
    } else {
      seen.add(value as object);
    }
  }

  if (typeof value === 'string') {
    const v = value.trim();
    if (!v || v === '[]' || v === '{}') return '';
    const parsed = tryParseJsonString(v);
    if (parsed !== null) return extractText(parsed, key, depth + 1, budget, seen);
    const out = key ? `${key}: ${v}` : v;
    if (out.length > budget.left) { const truncated = out.slice(0, budget.left); budget.left = 0; return truncated; }
    budget.left -= out.length;
    return out;
  }

  if (typeof value === 'number') {
    const out = key ? `${key}: ${value}` : String(value);
    if (out.length > budget.left) { const truncated = out.slice(0, budget.left); budget.left = 0; return truncated; }
    budget.left -= out.length;
    return out;
  }

  if (typeof value === 'boolean') {
    if (!value) return '';
    const out = key ? `${key}: ${value}` : String(value);
    if (out.length > budget.left) { const truncated = out.slice(0, budget.left); budget.left = 0; return truncated; }
    budget.left -= out.length;
    return out;
  }

  if (Array.isArray(value)) {
    const items = value
      .map(item => extractText(item, undefined, depth + 1, budget, seen))
      .filter(Boolean)
      .join(', ');
    return items ? (key ? `${key}: ${items}` : items) : '';
  }

  if (typeof value === 'object') {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (shouldSkip(k) || budget.left <= 0) continue;
      const text = extractText(v, k, depth + 1, budget, seen);
      if (text) parts.push(text);
    }
    return parts.join(' ');
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

  if (typeof body.model === 'string') {
    throw new ValidationError(
      `model parameter is not supported. Text embeddings always use ${GEMINI.model.id}.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  // task_type controls how Gemini optimizes the embedding vector.
  // Use RETRIEVAL_DOCUMENT (default) when indexing content into a vector DB.
  // Use RETRIEVAL_QUERY when embedding a search query against that content.
  const taskType: GeminiTaskType = (() => {
    if (!('task_type' in body)) return GEMINI.textTaskType as GeminiTaskType;
    if (typeof body.task_type !== 'string' || !(GEMINI_TASK_TYPES as readonly string[]).includes(body.task_type)) {
      throw new ValidationError(
        `Invalid task_type. Must be one of: ${GEMINI_TASK_TYPES.join(', ')}`,
        ERROR_CODES.INVALID_INPUT
      );
    }
    return body.task_type as GeminiTaskType;
  })();

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

  const text = normalizeInput(body.input);

  if (text.length === 0) {
    throw new ValidationError('Input cannot be empty', ERROR_CODES.INVALID_INPUT);
  }
  if (text.length > TEXT_MAX_CHARS) {
    throw new ValidationError(
      `Input exceeds maximum of ${TEXT_MAX_CHARS} characters. Truncate or summarize your input.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  await checkRateLimit(ctx.tenantId, 'text', env);

  const result = await callTextProvider([text], env.GEMINI_API_KEY, ctx.tenantId, taskType);
  const embedding = result.data[0].embedding;
  const tokenCount = result.usage?.total_tokens ?? 0;
  const estimatedCost = parseFloat(((tokenCount / 1_000_000) * GEMINI.model.costPer1M).toFixed(6));

  const latency_ms = Date.now() - ctx.startTime;
  console.log(JSON.stringify({ event: 'embed.success', endpoint: 'text', tenant_id: ctx.tenantId, latency_ms, model: GEMINI.model.id }));

  return jsonOk({
    success: true,
    embedding,
    model: GEMINI.model.id,
    dimensions: embedding.length,
    task_type: taskType,
    usage: { estimated_cost_usd: estimatedCost },
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
