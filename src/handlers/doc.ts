/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext, EmbeddingItem } from '../types';
import { ValidationError, WorkerError } from '../types';
import { jsonOk } from '../utils/response';
import { callPdfProvider, callDocProvider, GEMINI } from '../providers';
import {
  MAX_DOC_REQUEST_BODY_SIZE,
  MAX_DOC_BINARY_SIZE,
  ALLOWED_DOC_TYPES,
  DOC_CHUNK_SIZE,
  DOC_CHUNK_OVERLAP,
  DOC_MAX_CHUNKS,
  DOC_MAX_PAGES,
  DOC_CHARS_PER_PAGE,
  ERROR_CODES,
} from '../constants';
import { checkRateLimit } from '../utils/ratelimit';
import type { AllowedDocMimeType } from '../constants';

// PDFs are sent directly to Gemini (native multimodal). Max 6 pages per call.
const PDF_MIME = 'application/pdf';

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

    if (start + slice.length >= text.length) break;

    const advance = Math.max(DOC_CHUNK_SIZE - DOC_CHUNK_OVERLAP, Math.ceil(DOC_CHUNK_SIZE / 4));
    start += advance;
  }

  return chunks;
}

export async function handleDocEmbed(
  request: Request,
  ctx: RequestContext,
  env: Env
): Promise<Response> {
  const bodyText = await request.text().catch((err) => {
    console.error(JSON.stringify({ event: 'body_read_error', endpoint: 'doc', tenant_id: ctx.tenantId, error: err instanceof Error ? err.message : String(err) }));
    throw new WorkerError('Failed to read request body', ERROR_CODES.INTERNAL_ERROR, 500);
  });
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

  if (typeof body.model === 'string') {
    throw new ValidationError(
      `model parameter is not supported. Document embeddings always use ${GEMINI.model.id}.`,
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

  const MAX_BASE64_LEN = Math.ceil(MAX_DOC_BINARY_SIZE * 4 / 3) + 4;
  if (input.data.length > MAX_BASE64_LEN) {
    throw new ValidationError('input.data exceeds maximum encoded size', ERROR_CODES.INVALID_INPUT);
  }

  await checkRateLimit(ctx.tenantId, 'doc', env);

  const docType = ALLOWED_DOC_TYPES[mimeType as AllowedDocMimeType];
  const rawFilename = typeof input.filename === 'string' && input.filename.trim().length > 0
    ? input.filename.trim()
    : `document.${docType.ext}`;
  const filename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);

  let binaryData: Uint8Array;
  try {
    binaryData = Uint8Array.from(atob(input.data as string), c => c.charCodeAt(0));
  } catch {
    throw new ValidationError('input.data is not valid base64', ERROR_CODES.INVALID_INPUT);
  }

  if (binaryData.length > MAX_DOC_BINARY_SIZE) {
    throw new ValidationError(
      `Document binary size ${(binaryData.length / 1_000_000).toFixed(1)}MB exceeds maximum of ${MAX_DOC_BINARY_SIZE / 1_000_000}MB.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  // ── PDF: send directly to Gemini (native multimodal, up to 6 pages) ────────
  if (mimeType === PDF_MIME) {
    // Gemini processes the full PDF natively and caps at 6 pages internally.
    // Page-range extraction is not possible via the REST API, so max_pages cannot
    // be enforced here — reject it rather than advertising an unenforced limit.
    if (maxPages !== undefined) {
      throw new ValidationError(
        `max_pages is not supported for PDF inputs. Gemini processes the full PDF natively (up to ${GEMINI.maxPdfPagesPerRequest} pages). Split the document if you need to limit scope.`,
        ERROR_CODES.INVALID_INPUT
      );
    }

    const embedding = await callPdfProvider(input.data as string, env.GEMINI_API_KEY, ctx.tenantId);
    // Gemini REST does not return token counts — estimate at ~4 chars/token using binary size
    const estimatedTokens = Math.ceil(binaryData.length / 4);

    const latency_ms = Date.now() - ctx.startTime;
    console.log(JSON.stringify({ event: 'embed.success', endpoint: 'doc', type: 'pdf-native', tenant_id: ctx.tenantId, latency_ms, model: GEMINI.model.id }));

    return jsonOk({
      success: true,
      embeddings: [{ index: 0, embedding, dimensions: embedding.length }] as EmbeddingItem[],
      model: GEMINI.model.id,
      document: {
        filename,
        mimeType,
        type: docType.label,
        chunks: 1,
      },
      usage: { total_tokens: estimatedTokens, estimated_cost_usd: 0 },
      request_id: ctx.requestId,
      latency_ms,
    }, 200, request, env, ctx.requestId);
  }

  // ── DOCX / XLSX: convert to markdown via AI.toMarkdown, then chunk + embed ─
  const blob = new Blob([binaryData], { type: mimeType });
  let conversionResult: { name: string; format: string; data?: string; error?: string } | undefined;

  try {
    const results = await env.AI.toMarkdown(
      { name: filename, blob },
      { conversionOptions: { pdf: { metadata: false } } }
    );
    const item = Array.isArray(results) ? results[0] : results;
    if (!item || typeof item !== 'object') {
      throw new WorkerError('Unexpected response shape from document conversion', ERROR_CODES.INTERNAL_ERROR, 500);
    }
    const record = item as Record<string, unknown>;
    const { name, format, data: itemData, error: itemError } = record;
    if (typeof name !== 'string' || typeof format !== 'string') {
      throw new WorkerError('Missing required fields in conversion response', ERROR_CODES.INTERNAL_ERROR, 500);
    }
    if (format !== 'error' && typeof itemData !== 'string') {
      throw new WorkerError('Unexpected response shape from document conversion', ERROR_CODES.INTERNAL_ERROR, 500);
    }
    conversionResult = {
      name,
      format,
      data: typeof itemData === 'string' ? itemData : undefined,
      error: typeof itemError === 'string' ? itemError : undefined,
    };
  } catch (err) {
    if (err instanceof WorkerError || err instanceof ValidationError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout|timed out/i.test(msg);
    console.error(JSON.stringify({ event: 'toMarkdown.error', tenant_id: ctx.tenantId, filename, mimeType, binary_size: binaryData.length, request_id: ctx.requestId, error: msg }));
    throw new WorkerError(
      isTimeout
        ? 'Document conversion timed out. The file may be too large or complex.'
        : 'Document conversion failed. The file may be corrupted or unsupported.',
      ERROR_CODES.INTERNAL_ERROR,
      isTimeout ? 504 : 500
    );
  }

  if (!conversionResult) throw new WorkerError('Document conversion returned no result', ERROR_CODES.INTERNAL_ERROR, 500);

  if (conversionResult.format === 'error' || !conversionResult.data) {
    if (conversionResult.error) {
      console.error(JSON.stringify({ event: 'toMarkdown.format_error', tenant_id: ctx.tenantId, filename, mimeType, detail: conversionResult.error }));
    }
    throw new ValidationError(
      'Document could not be converted. Ensure the file is not password-protected, corrupted, or empty.',
      ERROR_CODES.INVALID_INPUT
    );
  }

  const markdown = conversionResult.data.trim();

  if (markdown.length === 0) {
    throw new ValidationError('Document produced no extractable text.', ERROR_CODES.INVALID_INPUT);
  }

  let processedMarkdown = markdown;
  let pagesDetected: number | undefined;
  let pagesProcessed: number | undefined;

  const minAdvancePerChunk = Math.ceil(DOC_CHUNK_SIZE / 4);
  const maxProcessableChars = DOC_MAX_CHUNKS * minAdvancePerChunk;

  if (maxPages === undefined && markdown.length > maxProcessableChars) {
    throw new ValidationError(
      `Document too large: ${markdown.length} chars exceeds maximum of ${maxProcessableChars}. Split the document and send in parts.`,
      ERROR_CODES.INVALID_INPUT
    );
  }

  if (maxPages !== undefined) {
    const pageResult = limitToPages(markdown, maxPages);
    processedMarkdown = pageResult.text;
    pagesDetected = pageResult.pagesDetected;
    pagesProcessed = pageResult.pagesProcessed;
    if (processedMarkdown.trim().length === 0) {
      throw new ValidationError('Document produced no text after page limit was applied', ERROR_CODES.INVALID_INPUT);
    }
  }

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

  const result = await callDocProvider(chunks, env.GEMINI_API_KEY, ctx.tenantId);
  // Gemini REST does not return token counts — estimate at ~4 chars/token
  const estimatedTokens = Math.ceil(processedMarkdown.length / 4);

  const latency_ms = Date.now() - ctx.startTime;
  console.log(JSON.stringify({ event: 'embed.success', endpoint: 'doc', type: 'text-chunks', tenant_id: ctx.tenantId, latency_ms, model: GEMINI.model.id, chunks: chunks.length }));

  return jsonOk({
    success: true,
    embeddings: result.embeddings.map((item): EmbeddingItem => ({
      index: item.index,
      embedding: item.embedding,
      dimensions: item.embedding.length,
    })),
    model: GEMINI.model.id,
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
    usage: { total_tokens: estimatedTokens, estimated_cost_usd: 0 },
    request_id: ctx.requestId,
    latency_ms,
  }, 200, request, env, ctx.requestId);
}
