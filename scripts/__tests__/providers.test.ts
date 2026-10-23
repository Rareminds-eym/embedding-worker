import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callTextProvider, GEMINI_MODEL_ID } from '../../src/providers';

test('text provider validates actual model and vector identity before returning metadata', async t => {
  const originalFetch = globalThis.fetch;
  const vector = () => Array(1536).fill(0.1);
  const response = () => ({ object: 'list', model: GEMINI_MODEL_ID,
    data: [{ object: 'embedding', index: 0, embedding: vector() }] });
  const cases = [
    ['wrong same-dimensional model', (value: any) => { value.model = 'another/model'; }],
    ['missing model', (value: any) => { delete value.model; }],
    ['wrong dimension', (value: any) => { value.data[0].embedding.pop(); }],
    ['zero vector', (value: any) => { value.data[0].embedding.fill(0); }],
    ['non-numeric component', (value: any) => { value.data[0].embedding[0] = null; }],
    ['wrong index', (value: any) => { value.data[0].index = 1; }],
    ['duplicate results', (value: any) => { value.data.push(value.data[0]); }],
  ] as const;
  try {
    await t.test('does not retry an uncertain query dispatch or a query 5xx',async()=>{
      for(const mode of ['transport','5xx']){
        let calls=0;
        globalThis.fetch=(async()=>{calls++;if(mode==='transport')throw new Error('network lost');return new Response('',{status:503});}) as typeof fetch;
        await assert.rejects(callTextProvider('Data analysis roles','test-key','test','https://app.test','RETRIEVAL_QUERY',undefined,{deadlineMs:Date.now()+3500,maxAttempts:1}));
        assert.equal(calls,1);
      }
    });
    await t.test('does not dispatch when caller deadline is already exhausted',async()=>{
      let calls=0;globalThis.fetch=(async()=>{calls++;return new Response('{}');}) as typeof fetch;
      await assert.rejects(callTextProvider('Data analysis roles','test-key','test','https://app.test','RETRIEVAL_QUERY',undefined,{deadlineMs:Date.now()-1,maxAttempts:1}));
      assert.equal(calls,0);
    });
    await t.test('preserves verified provider model and requests the worker-selected model', async () => {
      globalThis.fetch = (async (_url: unknown, options: any) => {
        const body = JSON.parse(options.body);
        assert.equal(body.model, GEMINI_MODEL_ID);
        assert.equal(body.input_type, 'search_query');
        return new Response(JSON.stringify(response()), { status: 200 });
      }) as typeof fetch;
      const result = await callTextProvider('Data analysis roles', 'test-key', 'test', 'https://app.test', 'RETRIEVAL_QUERY');
      assert.equal(result.model, GEMINI_MODEL_ID);
      assert.deepEqual(result.embedding, vector());
    });
    for (const [name, mutate] of cases) await t.test(`rejects ${name} without retry`, async () => {
      const value = response(); mutate(value);
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(JSON.stringify(value), { status: 200 });
      }) as typeof fetch;
      await assert.rejects(callTextProvider('Data analysis roles', 'test-key', 'test', 'https://app.test'));
      assert.equal(calls, 1);
    });
  } finally { globalThis.fetch = originalFetch; }
});
