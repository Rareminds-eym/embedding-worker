import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embeddingCapabilities } from '../../src/capabilities';
import { GEMINI_MODEL_ID, GEMINI_DIMENSIONS, GEMINI_TASK_TYPES } from '../../src/providers';

test('capabilities describe the generation contract without an environment or provider request', () => {
  assert.deepEqual(embeddingCapabilities(), {
    model: GEMINI_MODEL_ID, dimensions: GEMINI_DIMENSIONS, task_types: [...GEMINI_TASK_TYPES],
  });
  const value = embeddingCapabilities();
  value.task_types.length = 0;
  assert.ok(embeddingCapabilities().task_types.includes('RETRIEVAL_DOCUMENT'));
});
