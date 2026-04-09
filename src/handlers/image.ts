/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, EmbeddingItem } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { callImageProvider, GEMINI_MODEL_ID } from '../providers';
import {
  MAX_IMAGE_BATCH_SIZE,
  MAX_IMAGE_REQUEST_BODY_SIZE,
  MAX_IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_FETCH_SIZE,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  ERROR_CODES,
} from '../constants';
import { checkRateLimit } from '../utils/ratelimit';

type SupportedMediaType = typeof SUPPORTED_IMAGE_MEDIA_TYPES[number];

// Covers IPv4 private ranges, loopback, link-local, CGNAT, and common internal hostnames.
// IPv6: strip brackets and zone IDs before matching.
// Full SSRF protection relies on Cloudflare's network isolation — this is a defence-in-depth layer.
const PRIVATE_IPV4 = /^(127\.|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.1[89]\.|0\.0\.0\.0$)/;
const PRIVATE_IPV6 = /^(::1|::ffff:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)/i;
const PRIVATE_HOSTNAME = /^(localhost|metadata\.google\.internal)$/i;

function isPrivateHost(hostname: string): boolean {
  // Strip IPv6 brackets and zone ID (e.g. [fe80::1%eth0] → fe80::1)
  const bare = hostname.startsWith('[')
    ? hostname.slice(1, hostname.indexOf(']') !== -1 ? hostname.indexOf(']') : undefined).split('%')[0]
    : hostname.split('%')[0];

  return (
    PRIVATE_HOSTNAME.test(bare) ||
    bare.endsWith('.internal') ||
    bare.endsWith('.local') ||
    PRIVATE_IPV4.test(bare) ||
    PRIVATE_IPV6.test(bare)
  );
}

interface ImageInputUrl    { type: 'url';    data: string; }
interface ImageInputBase64 { type: 'base64'; data: string; mediaType: SupportedMediaType; }
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
  // Pre-fetch SSRF guard: reject known-private hostnames before any network call.
  // The post-fetch check on res.url remains as defence-in-depth against open redirects.
  if (isPrivateHost(parsed.hostname)) {
    throw new ValidationError('URL resolves to a private or internal address', ERROR_CODES.INVALID_INPUT);
  }
  return raw;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseInput(input: unknown): ImageInput[] {
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

    if (!(SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(obj.mediaType as string)) {
      throw new ValidationError(
        `input.mediaType must be one of: ${SUPPORTED_IMAGE_MEDIA_TYPES.join(', ')}`,
        ERROR_CODES.INVALID_INPUT
      );
    }
    return { type: 'base64', data: obj.data as string, mediaType: obj.mediaType as SupportedMediaType };
  };

  if (Array.isArray(input)) {
    if (input.length === 0) throw new ValidationError('input array must not be empty', ERROR_CODES.INVALID_INPUT);
    return input.map(toItem);
  }
  return [toItem(input)];
}

async function fetchImageAsBase64(url: string, tenantId: string): Promise<{ data: string; mediaType: SupportedMediaType }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(MAX_IMAGE_FETCH_TIMEOUT_MS) });
  } catch (err) {
    console.error(JSON.stringify({ event: 'image_fetch.error', tenant_id: tenantId, error: err instanceof Error ? err.message : String(err) }));
    throw new WorkerError('Failed to fetch image URL', ERROR_CODES.INTERNAL_ERROR, 502);
  }

  if (!res.ok) {
    throw new ValidationError(`Image URL returned HTTP ${res.status}`, ERROR_CODES.INVALID_INPUT);
  }

  const resolvedHostname = new URL(res.url).hostname;
  if (isPrivateHost(resolvedHostname)) {
    console.error(JSON.stringify({ event: 'ssrf.redirect_blocked', tenant_id: tenantId, resolved: resolvedHostname }));
    throw new ValidationError('URL resolved to a private or internal address', ERROR_CODES.INVALID_INPUT);
  }

  const contentLength = res.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_FETCH_SIZE) {
    throw new ValidationError(`Image exceeds maximum size of ${MAX_IMAGE_FETCH_SIZE} bytes`, ERROR_CODES.INVALID_INPUT);
  }

  const rawType = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  const mimeType = rawType === 'image/jpg' ? 'image/jpeg' : rawType;

  if (!(SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mimeType)) {
    throw new ValidationError(
      `Image content type "${mimeType}" is not supported. Accepted: ${SUPPORTED_IMAGE_MEDIA_TYPES.join(', ')}.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_FETCH_SIZE) {
    throw new ValidationError(`Image exceeds maximum size of ${MAX_IMAGE_FETCH_SIZE} bytes`, ERROR_CODES.INVALID_INPUT);
  }

  const data = uint8ToBase64(new Uint8Array(buffer));
  return { data, mediaType: mimeType as SupportedMediaType };
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
    throw new ValidationError(`Request body exceeds limit of ${MAX_IMAGE_REQUEST_BODY_SIZE} bytes`, ERROR_CODES.INVALID_INPUT);
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
      `model parameter is not supported. Image embeddings always use ${GEMINI_MODEL_ID}.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const inputs = parseInput(body.input);

  if (inputs.length > MAX_IMAGE_BATCH_SIZE) {
    throw new ValidationError(`Batch size exceeds maximum of ${MAX_IMAGE_BATCH_SIZE}`, ERROR_CODES.INVALID_INPUT);
  }

  await checkRateLimit(ctx.tenantId, 'image', env);

  // Fetch URL inputs with a concurrency cap to avoid exhausting the connection pool.
  // base64 inputs are already in memory — no fetch needed, resolve immediately.
  const resolved: { mime_type: string; data: string }[] = new Array(inputs.length);
  const urlInputs = inputs
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.type === 'url');

  const FETCH_CONCURRENCY = 2;
  for (let offset = 0; offset < urlInputs.length; offset += FETCH_CONCURRENCY) {
    await Promise.all(
      urlInputs.slice(offset, offset + FETCH_CONCURRENCY).map(async ({ item, i }) => {
        const { data, mediaType } = await fetchImageAsBase64((item as ImageInputUrl).data, ctx.tenantId);
        resolved[i] = { mime_type: mediaType, data };
      })
    );
  }
  for (const { item, i } of inputs.map((item, i) => ({ item, i }))) {
    if (item.type === 'base64') {
      resolved[i] = { mime_type: item.mediaType, data: item.data };
    }
  }

  // Cap Gemini embed concurrency to avoid amplifying 429s under rate limiting.
  // With MAX_RETRIES=3 and MAX_IMAGE_BATCH_SIZE=6, fully parallel would allow
  // 24 simultaneous in-flight requests from a single user request.
  const IMAGE_EMBED_CONCURRENCY = 2;
  const embeddings: EmbeddingItem[] = [];
  for (let offset = 0; offset < resolved.length; offset += IMAGE_EMBED_CONCURRENCY) {
    const batch = await Promise.all(
      resolved.slice(offset, offset + IMAGE_EMBED_CONCURRENCY).map(async ({ mime_type, data }, j) => {
        const i = offset + j;
        const embedding = await callImageProvider({ mime_type, data }, env.GEMINI_API_KEY, ctx.tenantId);
        return { index: i, embedding, dimensions: embedding.length };
      })
    );
    embeddings.push(...batch);
  }

  const latency_ms = Date.now() - ctx.startTime;
  console.log(JSON.stringify({ event: 'embed.success', endpoint: 'image', tenant_id: ctx.tenantId, latency_ms, model: GEMINI_MODEL_ID, count: embeddings.length }));

  return jsonOk({
    success: true,
    embeddings,
    model: GEMINI_MODEL_ID,
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
