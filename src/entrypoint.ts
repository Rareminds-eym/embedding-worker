/// <reference types="@cloudflare/workers-types" />

/**
 * EmbeddingService WorkerEntrypoint — exposes embedding generation as typed RPC
 * methods callable via Cloudflare Service Bindings.
 *
 * Unlike the HTTP route handlers, these methods accept typed parameters and
 * return typed results (or throw Errors). No Request/Response, no HTTP status
 * codes, no Bearer-token auth — service bindings are trusted worker-to-worker
 * calls routed inside Cloudflare's network with zero added latency.
 *
 * Errors thrown across the RPC boundary are normalized to a `CODE: message`
 * format (mirroring payment-worker) so callers can map them to HTTP statuses
 * without depending on this worker's error classes. See {@link toRpcError}.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { embeddingCapabilities } from './capabilities';
import { toRpcError } from './utils/rpc-error';
import type { Env, EmbeddingItem } from './types';
import { embedTextCore } from './handlers/text';
import { embedImageCore } from './handlers/image';
import { embedDocCore, type DocMetadata } from './handlers/doc';

// ─── Exported Result Types ──────────────────────────────────────────────────────
// Mirrored locally in the consumer's binding helper to avoid cross-project imports.

export interface EmbedTextResult {
  embedding: number[];
  model: string;
  dimensions: number;
  task_type: string;
}

export interface EmbedImageResult {
  embeddings: EmbeddingItem[];
  model: string;
}

export interface EmbedDocResult {
  embeddings: EmbeddingItem[];
  model: string;
  document: DocMetadata;
}

export interface DocInput {
  mimeType: string;
  /** Base64-encoded document bytes. */
  data: string;
  filename?: string;
}

/**
 * The synthetic caller id used for rate-limit bucketing and log correlation on
 * RPC calls. HTTP callers share the `http` bucket; binding callers share this bucket.
 */
const RPC_CALLER_ID = 'rpc';

export class EmbeddingService extends WorkerEntrypoint<Env> {
  /** Provider metadata only: no generation request, credentials or app state. */
  getCapabilities() {
    return embeddingCapabilities();
  }

  /**
   * Generate a single text embedding.
   *
   * @param input - String, object, or array (arrays are joined into one embedding).
   * @param taskType - Optional Gemini task type; omit for RETRIEVAL_DOCUMENT.
   * @returns The embedding vector plus model metadata.
   * @throws Error with a `CODE:` prefix (INVALID_INPUT, RATE_LIMIT_EXCEEDED,
   *   PROVIDER_ERROR, INTERNAL_ERROR).
   */
  async embedText(input: unknown, taskType?: string): Promise<EmbedTextResult> {
    try {
      return await embedTextCore(input, taskType, this.env, RPC_CALLER_ID);
    } catch (err) {
      throw toRpcError(err);
    }
  }

  /**
   * Generate embeddings for one or more images (max 6 per call).
   *
   * @param input - A single image input or an array. Each item is
   *   `{ type: 'url', data }` or `{ type: 'base64', data, mediaType }`.
   * @returns One embedding per input image, in input order.
   * @throws Error with a `CODE:` prefix.
   */
  async embedImage(input: unknown): Promise<EmbedImageResult> {
    try {
      return await embedImageCore(input, this.env, RPC_CALLER_ID);
    } catch (err) {
      throw toRpcError(err);
    }
  }

  /**
   * Generate embeddings for a document (PDF / DOCX / XLSX).
   *
   * @param input - `{ mimeType, data (base64), filename? }`.
   * @param maxPages - Optional page cap (DOCX/XLSX only; must be omitted for PDF).
   * @returns Embeddings (one per chunk; one for PDFs) plus document metadata.
   * @throws Error with a `CODE:` prefix.
   */
  async embedDoc(input: DocInput, maxPages?: number): Promise<EmbedDocResult> {
    try {
      return await embedDocCore(input, maxPages, this.env, RPC_CALLER_ID);
    } catch (err) {
      throw toRpcError(err);
    }
  }
}
