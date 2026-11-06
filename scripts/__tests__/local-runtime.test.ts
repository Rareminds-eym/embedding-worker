import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';
import { unstable_readConfig } from 'wrangler';
import { embedDocCore } from '../../src/handlers/doc';
import { checkRateLimit } from '../../src/utils/ratelimit';
import type { Env } from '../../src/types';

const config = fileURLToPath(new URL('../../wrangler.toml', import.meta.url));
test('local configuration has no bindings that establish a Cloudflare AI preview session', () => {
  const local = unstable_readConfig({ config }, { hideWarnings: true });
  assert.equal(local.ai?.binding, undefined);
  assert.equal(local.unsafe?.bindings?.length || 0, 0);
  assert.equal(local.vars.ENVIRONMENT, 'local');
  assert.equal(local.kv_namespaces[0].binding, 'EMBEDDING_KV');
});
for (const env of ['dev', 'qa', 'staging', 'production']) {
  test(`${env} retains the deployed Workers AI binding`, () => {
    assert.equal(unstable_readConfig({ config, env }, { hideWarnings: true }).ai?.binding, 'AI');
  });
}
test('realtime queue waits use the supported configuration key', () => {
  const realtime = fileURLToPath(new URL('../../../realtime-worker/wrangler.toml', import.meta.url));
  for (const env of [undefined, 'dev']) {
    const parsed = unstable_readConfig({ config: realtime, env }, { hideWarnings: true });
    assert.equal(parsed.queues.consumers[0].max_batch_timeout, 5);
    assert.equal('max_wait_time' in parsed.queues.consumers[0], false);
  }
});
for (const mimeType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) {
  test(`local ${mimeType} conversion reports unavailable before quota or provider calls`, async () => {
    const get = mock.fn(async () => null), put = mock.fn(async () => {});
    const fetcher = mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected provider request'); });
    try {
      const env = { ENVIRONMENT: 'local', OPENROUTER_API_KEY: 'synthetic', EMBEDDING_KV: { get, put } } as unknown as Env;
      await assert.rejects(embedDocCore({ mimeType, data: btoa('synthetic document') }, undefined, env, 'test'),
        (error: unknown) => error instanceof Error && 'status' in error && error.status === 503 && error.message.includes('Workers AI'));
      assert.equal(get.mock.callCount(), 0); assert.equal(put.mock.callCount(), 0); assert.equal(fetcher.mock.callCount(), 0);
    } finally { fetcher.mock.restore(); }
  });
}
test('local requests use the existing KV rate limiter while deployments require the native limiter', async () => {
  const get = mock.fn(async () => null), put = mock.fn(async () => {});
  const env = { ENVIRONMENT: 'local', EMBEDDING_KV: { get, put } } as unknown as Env;
  await checkRateLimit('test', 'text', env);
  assert.equal(get.mock.callCount(), 1); assert.equal(put.mock.callCount(), 1);
  await assert.rejects(checkRateLimit('test', 'text', { ...env, ENVIRONMENT: 'production' }),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 503);
  assert.equal(get.mock.callCount(), 1);
});
