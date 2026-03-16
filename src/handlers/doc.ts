/// <reference types="@cloudflare/workers-types" />

import type { Env, RequestContext } from '../types';
import { WorkerError } from '../types';
import { ERROR_CODES } from '../constants';

export async function handleDocEmbed(
  _request: Request,
  _ctx: RequestContext,
  _env: Env
): Promise<Response> {
  throw new WorkerError(
    'Document embeddings are not yet implemented. Coming in phase 2.',
    ERROR_CODES.NOT_IMPLEMENTED,
    501
  );
}
