import assert from 'node:assert/strict';
import test from 'node:test';
import { installModelRejectionGuard, isContainedModelRejection } from '../runtime/model-rejection-guard.mjs';

test('contains only rejections caused by the local model adapter', () => {
  const upstream = Object.assign(new Error('API key quota exhausted'), {
    name: 'ModelRequestError', status: 429, code: 'API_KEY_QUOTA_EXHAUSTED',
  });
  const harness = Object.assign(new Error('request failed'), { name: 'NonRetriableError', cause: upstream });
  assert.equal(isContainedModelRejection(harness), true);
  assert.equal(isContainedModelRejection(upstream), true);
  assert.equal(isContainedModelRejection(new Error('unrelated defect')), false);
  assert.equal(isContainedModelRejection({ cause: { name: 'TypeError' } }), false);
});

test('the process guard contains a model failure but preserves unrelated rejection failure', () => {
  let listener;
  installModelRejectionGuard({ on(event, callback) { assert.equal(event, 'unhandledRejection'); listener = callback; } });
  const original = console.error, messages = [];
  console.error = message => messages.push(message);
  try {
    listener(Object.assign(new Error('quota'), { cause: Object.assign(new Error('provider'), { name: 'ModelRequestError', status: 429 }) }));
  } finally {
    console.error = original;
  }
  assert.match(messages[0], /contained unhandled model rejection/);
  assert.throws(() => listener(new Error('unrelated defect')), /unrelated defect/);
});
