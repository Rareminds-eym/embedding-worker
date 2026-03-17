/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { resolveDocModel, callDocProvider, VOYAGE } from '../providers';
import {
  MAX_DOC_REQUEST_BODY_SIZE,
  MAX_DOC_BINARY_SIZE,
  ALLOWED_DOC_TYPES,
  DOC_CHUNK_SIZE,
  DOC_CHUNK_OVERLAP,
  DOC_MAX_CHUNKS,
  DOC_MAX_PAGES,
  DOC_CHARS_PER_PAGE,
  DOC_MIN_CONTENT_CHARS,
  ERROR_CODES,
} from '../constants';
import type { AllowedDocMimeType } from '../constants';

function limitToPages(markdown: string, maxPages: number): { text: string; pagesDetected: number; pagesProcessed: number } {
  const formFeeds = markdown.split('\f');
  if (formFeeds.length > 1) {
    const pagesDetected = formFeeds.length;
    return {
      text: formFeeds.slice(0, maxPages).join('\f'),
      pagesDetected,
      pagesProcessed: Math.min(maxPages, pagesDetected),
    };
  }
  const estimatedPages = Math.ceil(markdown.length / DOC_CHARS_PER_PAGE);
  return {
    text: markdown.slice(0, maxPages * DOC_CHARS_PER_PAGE),
    pagesDetected: estimatedPages,
    pagesProcessed: Math.min(maxPages, estimatedPages),
  };
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length && chunks.length < DOC_MAX_CHUNKS) {
    const end = start + DOC_CHUNK_SIZE;
    let slice = text.slice(start, end);

    if (end < text.length) {
      const lastBreak = slice.lastIndexOf('\n\n');
      if (lastBreak > DOC_CHUNK_SIZE / 2) slice = slice.slice(0, lastBreak);
    }

    const trimmed = slice.trim();
    if (trimmed.length > 0) chunks.push(trimmed);

    const advance = slice.length - DOC_CHUNK_OVERLAP;
    if (advance <= 0) break;
    start += advance;
  }

  return chunks;
}

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

  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && !VOYAGE.textModelKeys.includes(modelKey)) {
    throw new ValidationError(
      `Invalid model. Must be one of: ${VOYAGE.textModelKeys.join(', ')}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const maxPages = (() => {
    if (!('max_pages' in body)) return undefined;
    const v = Number(body.max_pages);
    if (!Number.isInteger(v) || v < 1) throw new ValidationError('max_pages must be a positive integer', ERROR_CODES.INVALID_INPUT);
    if (v > DOC_MAX_PAGES) throw new ValidationError(`max_pages cannot exceed ${DOC_MAX_PAGES}`, ERROR_CODES.INVALID_INPUT);
    return v;
  })();

  const input = body.input as Record<string, unknown>;
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('input must be an object', ERROR_CODES.INVALID_INPUT);
  }

  const mimeType = input.mimeType as string;
  if (!mimeType || !Object.prototype.hasOwnProperty.call(ALLOWED_DOC_TYPES, mimeType)) {
    throw new ValidationError(
      `input.mimeType must be one of: ${Object.keys(ALLOWED_DOC_TYPES).join(', ')}`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  if (typeof input.data !== 'string' || input.data.trim().length === 0) {
    throw new ValidationError('input.data must be a non-empty base64 string', ERROR_CODES.INVALID_INPUT);
  }

  const docType = ALLOWED_DOC_TYPES[mimeType as AllowedDocMimeType];
  const filename = typeof input.filename === 'string' && input.filename.trim().length > 0
    ? input.filename.trim()
    : `document.${docType.ext}`;

  let binaryData: Uint8Array;
  try {
    const binaryStr = atob(input.data as string);
    binaryData = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) binaryData[i] = binaryStr.charCodeAt(i);
  } catch {
    throw new ValidationError('input.data is not valid base64', ERROR_CODES.INVALID_INPUT);
  }

  if (binaryData.length > MAX_DOC_BINARY_SIZE) {
    throw new ValidationError(
      `Document binary size ${(binaryData.length / 1_000_000).toFixed(1)}MB exceeds maximum of ${MAX_DOC_BINARY_SIZE / 1_000_000}MB. Use max_pages to reduce scope or split the document.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const blob = new Blob([binaryData], { type: mimeType });
  let conversionResult: { name: string; format: string; data?: string; error?: string };

  try {
    const results = await env.AI.toMarkdown(
      { name: filename, blob },
      { conversionOptions: { pdf: { metadata: false } } }
    );
    const item = Array.isArray(results) ? results[0] : results;
    if (!item) throw new WorkerError('Document conversion returned no result', ERROR_CODES.INTERNAL_ERROR, 500);
    conversionResult = item;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout|timed out/i.test(msg);
    console.error(JSON.stringify({ event: 'toMarkdown.error', tenant_id: ctx.tenantId, filename, mimeType, error: msg }));
    throw new WorkerError(
      isTimeout
        ? 'Document conversion timed out. The file may be too large or complex.'
        : 'Document conversion failed. The file may be corrupted or unsupported.',
      ERROR_CODES.INTERNAL_ERROR,
      isTimeout ? 504 : 500
    );
  }

  if (conversionResult.format === 'error' || !conversionResult.data) {
    throw new ValidationError(
      `Document could not be converted: ${conversionResult.error ?? 'unknown error'}. Ensure the file is not password-protected or corrupted.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  const markdown = conversionResult.data.trim();

  if (env.ENVIRONMENT !== 'production') {
    console.debug(`[doc-embed:markdown] format=${conversionResult.format} raw_chars=${markdown.length} snippet=${JSON.stringify(markdown.slice(0, 120))}`);
  }

  if (markdown.length === 0) {
    throw new ValidationError(
      'Document produced no extractable text. This PDF appears to be image-only (scanned). Use /embeddings/image to embed individual page images instead.',
      ERROR_CODES.INVALID_INPUT
    );
  }

  if (mimeType === 'application/pdf' && markdown.length < DOC_MIN_CONTENT_CHARS) {
    throw new ValidationError(
      `Document produced only ${markdown.length} characters of text. This PDF may be image-only or scanned. Use /embeddings/image to embed individual page images instead.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  let processedMarkdown = markdown;
  let pagesDetected: number | undefined;
  let pagesProcessed: number | undefined;

  if (maxPages !== undefined) {
    const pageResult = limitToPages(markdown, maxPages);
    processedMarkdown = pageResult.text;
    pagesDetected = pageResult.pagesDetected;
    pagesProcessed = pageResult.pagesProcessed;
    if (processedMarkdown.trim().length === 0) {
      throw new ValidationError('Document produced no text after page limit was applied', ERROR_CODES.INVALID_INPUT);
    }
  }

  const maxProcessableChars = DOC_MAX_CHUNKS * (DOC_CHUNK_SIZE - DOC_CHUNK_OVERLAP);
  if (processedMarkdown.length > maxProcessableChars) {
    throw new ValidationError(
      `Document too large: ${processedMarkdown.length} chars exceeds maximum of ${maxProcessableChars}. Split the document and send in parts.`,
      ERROR_CODES.INVALID_INPUT
    );
  }
  const chunks = chunkText(processedMarkdown);
  if (chunks.length === 0) {
    throw new ValidationError('Document produced no embeddable chunks', ERROR_CODES.INVALID_INPUT);
  }

  if (env.ENVIRONMENT !== 'production') {
    console.debug(`[doc-embed] tenant=${ctx.tenantId} req=${ctx.requestId} chars=${processedMarkdown.length} chunks=${chunks.length}${maxPages !== undefined ? ` max_pages=${maxPages}` : ''}`);
  }

  const modelConfig = resolveDocModel(modelKey);
  const result = await callDocProvider(chunks, modelConfig.id, env.VOYAGE_API_KEY, ctx.tenantId);
  const totalTokens = result.total_tokens;
  const estimatedCost = ((totalTokens / 1_000_000) * modelConfig.costPer1M).toFixed(6);

  return jsonOk({
    success: true,
    embeddings: result.embeddings.map(item => ({
      index: item.index,
      embedding: item.embedding,
      dimensions: item.embedding.length,
    })),
    model: modelConfig.id,
    document: {
      filename,
      mimeType,
      type: docType.label,
      total_chars: processedMarkdown.length,
      chunks: chunks.length,
      chunk_size: DOC_CHUNK_SIZE,
      chunk_overlap: DOC_CHUNK_OVERLAP,
      ...(pagesDetected !== undefined && { pages_detected: pagesDetected, pages_processed: pagesProcessed }),
    },
    usage: {
      total_tokens: totalTokens,
      estimated_cost_usd: estimatedCost,
    },
    request_id: ctx.requestId,
    latency_ms: Date.now() - ctx.startTime,
  }, 200, request, env);
}
