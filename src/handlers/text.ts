/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError, ProviderError } from '../types';
import { jsonOk } from '../utils/response';
import { OPENROUTER, resolveModel } from '../providers';
import {
  MAX_INPUT_CHARS,
  MAX_BATCH_SIZE,
  MAX_REQUEST_BODY_SIZE,
  OPENROUTER_TIMEOUT_MS,
  RETRY_DELAY_MS,
  MAX_RETRIES,
  ERROR_CODES,
} from '../constants';

// ── Normalize input to string[] ────────────────────────────
function normalizeInput(input: unknown): string[] {
  if (typeof input === 'string') {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.map(item =>
      typeof item === 'string' ? item : JSON.stringify(item)
    );
  }
  if (typeof input === 'object' && input !== null) {
    return [JSON.stringify(input)];
  }
  throw new ValidationError(
    'input must be a string, array, or object',
    ERROR_CODES.INVALID_INPUT
  );
}

// ── Call OpenRouter embeddings API ─────────────────────────
async function callOpenRouter(
  inputs: string[],
  model: string,
  apiKey: string,
  tenantId: string,
  attempt = 0
): Promise<{ data: { embedding: number[] }[]; usage: { prompt_tokens: number } }> {
  const res = await fetch(OPENROUTER.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });

  // Retry once on 5xx
  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    return callOpenRouter(inputs, model, apiKey, tenantId, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Log full error internally — never expose to client
    console.error(JSON.stringify({
      event: 'provider.error',
      status: res.status,
      body: errText.slice(0, 500),
      tenant_id: tenantId,
      model,
    }));
    throw new ProviderError(`Embedding provider error (${res.status})`, res.status);
  }

  const json = await res.json() as { data: { embedding: number[] }[]; usage: { prompt_tokens: number } };

  // Validate provider response shape before use
  if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
    console.error(JSON.stringify({ event: 'provider.invalid_response', tenant_id: tenantId, model }));
    throw new ProviderError('Invalid response from embedding provider', 502);
  }

  return json;
}

// ── Handler ────────────────────────────────────────────────
export async function handleTextEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  // Secondary body size check — Content-Length header can be omitted by clients
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

  const inputs = normalizeInput(body.input);

  if (inputs.length > MAX_BATCH_SIZE) {
    throw new ValidationError(
      `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  for (const item of inputs) {
    if (item.trim().length === 0) {
      throw new ValidationError('Input items cannot be empty', ERROR_CODES.INVALID_INPUT);
    }
    if (item.length > MAX_INPUT_CHARS) {
      throw new ValidationError(
        `Input item exceeds maximum of ${MAX_INPUT_CHARS} characters`,
        ERROR_CODES.INVALID_INPUT
      );
    }
  }

  const modelConfig = resolveModel(undefined);
  const result = await callOpenRouter(inputs, modelConfig.id, env.OPENROUTER_API_KEY, ctx.tenantId);

  const firstItem = result.data[0];
  const embedding: number[] = firstItem.embedding;
  const promptTokens = result.usage?.prompt_tokens ?? 0;
  const estimatedCost = ((promptTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6);

  return jsonOk({
    success: true,
    embedding,
    model: modelConfig.id,
    dimensions: embedding.length,
    usage: {
      prompt_tokens: promptTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms: Date.now() - ctx.startTime,
  }, 200, request, env);
}
