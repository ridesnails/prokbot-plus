import test from 'node:test';
import assert from 'node:assert/strict';
import { clientId } from '../server/public/ids.js';

test('client IDs remain usable when the admin page is served over insecure HTTP', () => {
  const first = clientId('provider', {}), second = clientId('provider', {});
  assert.match(first, /^provider-[a-z0-9]+$/);
  assert.match(second, /^provider-[a-z0-9]+$/);
  assert.notEqual(first, second);
});

test('client IDs use randomUUID when the browser makes it available', () => {
  assert.equal(clientId('profile', { randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef' }), 'profile-01234567');
});
