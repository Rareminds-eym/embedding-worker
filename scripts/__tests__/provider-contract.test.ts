import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { callTextProvider, GEMINI_MODEL_ID } from '../../src/providers';
import { embedTextCore } from '../../src/handlers/text';
import { toRpcError } from '../../src/utils/rpc-error';
import { AuthError, ProviderError, RateLimitError, ValidationError, WorkerError, type Env } from '../../src/types';

const vector = Array(1536).fill(0.1);
const environment = {
  OPENROUTER_API_KEY: 'synthetic', ALLOWED_ORIGINS: 'https://app.example.test',
  RATE_LIMITER: { limit: async () => ({ success: true }) },
} as unknown as Env;

for (const responseModel of [undefined, null, '', 'another/model', 'gemini-embedding-001', 'other/gemini-embedding-2-preview', 'gemini-embedding-2-preview', GEMINI_MODEL_ID]) {
  const accepted = responseModel === GEMINI_MODEL_ID || responseModel === 'gemini-embedding-2-preview';
  test(`provider response model ${String(responseModel)} is ${accepted ? 'accepted' : 'rejected'}`, async () => {
    const fetcher = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      object: 'list', model: responseModel, data: [{ object: 'embedding', index: 0, embedding: vector }],
    }), { headers: { 'Content-Type': 'application/json' } }));
    try {
      const generate = () => callTextProvider('job text', 'synthetic', 'test', 'https://app.example.test');
      if (accepted) assert.deepEqual((await generate()).embedding, vector);
      else await assert.rejects(generate(), error => error instanceof ProviderError && error.message.includes('invalid response'));
      assert.equal(fetcher.mock.callCount(), 1);
      const body = JSON.parse(String(fetcher.mock.calls[0].arguments[1]?.body));
      assert.equal(body.model, GEMINI_MODEL_ID);
    } finally { fetcher.mock.restore(); }
  });
}

test('upstream 429 beyond request deadline retains its delay in the actual RPC error serializer', async () => {
  const fetcher = mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 429, headers: { 'Retry-After': '120' },
  }));
  try {
    let internal: unknown;
    try { await embedTextCore('job text', 'RETRIEVAL_DOCUMENT', environment, 'test'); }
    catch (error) { internal = error; }
    assert.ok(internal instanceof RateLimitError);
    assert.equal(internal.retryAfterSeconds, 120);
    // This is the early-deadline branch, whose original message has no seconds.
    assert.doesNotMatch(internal.message, /120/);
    const transported = toRpcError(internal);
    assert.equal(transported.message, 'RATE_LIMIT_EXCEEDED: Rate limit exceeded. Retry after 120s.');
    assert.equal(/Retry after (\d+)s/.exec(transported.message)?.[1], '120');
    assert.equal(fetcher.mock.callCount(), 1);
  } finally { fetcher.mock.restore(); }
});

test('RPC serializer retains valid HTTP-date backoff after provider parsing', async () => {
  const retryAt = new Date(Date.now() + 180000).toUTCString();
  const fetcher = mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 429, headers: { 'Retry-After': retryAt },
  }));
  try {
    await assert.rejects(embedTextCore('job text', undefined, environment, 'test'), error => {
      assert.ok(error instanceof RateLimitError);
      const seconds = Number(/Retry after (\d+)s/.exec(toRpcError(error).message)?.[1]);
      assert.ok(seconds >= 175 && seconds <= 180);
      return true;
    });
  } finally { fetcher.mock.restore(); }
});

for (const delay of [undefined, NaN, Infinity, -1, 0, 86401]) {
  test(`invalid RPC retry delay ${String(delay)} uses a safe generic message`, () => {
    assert.equal(toRpcError(new RateLimitError('untrusted message Retry after 999999s.', delay)).message,
      'RATE_LIMIT_EXCEEDED: Rate limit exceeded. Please wait before retrying.');
  });
}

test('fractional valid retry delays round up rather than retry early', () => {
  assert.equal(toRpcError(new RateLimitError('limited', 120.1)).message,
    'RATE_LIMIT_EXCEEDED: Rate limit exceeded. Retry after 121s.');
});

test('other error codes retain their existing RPC serialization', () => {
  for (const [error, expected] of [
    [new ValidationError('invalid', 'ignored'), 'INVALID_INPUT: invalid'],
    [new ProviderError('unavailable', 502), 'PROVIDER_ERROR: unavailable'],
    [new AuthError('denied', 'ignored'), 'UNAUTHORIZED: denied'],
    [new WorkerError('unavailable', 'SERVICE_UNAVAILABLE'), 'SERVICE_UNAVAILABLE: unavailable'],
    [new Error('unexpected'), 'INTERNAL_ERROR: unexpected'],
  ] as const) assert.equal(toRpcError(error).message, expected);
});
