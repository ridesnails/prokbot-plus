import assert from 'node:assert/strict';
import test from 'node:test';
import { syncRenamedDirectory } from '../server/storage.mjs';

function handle(sync) {
  let closed = false;
  return { sync, close: async () => { closed = true; }, get closed() { return closed; } };
}

test('Windows accepts EPERM only when syncing a renamed directory', async () => {
  const error = Object.assign(new Error('directory fsync is unsupported'), { code: 'EPERM' });
  const directory = handle(async () => { throw error; });
  await syncRenamedDirectory('fixture', { platform: 'win32', openFile: async () => directory });
  assert.equal(directory.closed, true);
});

test('directory sync failures remain fatal on other platforms and error codes', async () => {
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EIO']]) {
    const error = Object.assign(new Error('sync failure'), { code });
    const directory = handle(async () => { throw error; });
    await assert.rejects(syncRenamedDirectory('fixture', { platform, openFile: async () => directory }), error);
    assert.equal(directory.closed, true);
  }
});
