import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalServices } from '../clients/desktop/local-services.mjs';

async function fixture(t) {
  const profile = await mkdtemp(path.join(tmpdir(), 'plus-profile-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  return { profile, file: path.join(profile, 'local-client-persistence.json') };
}

test('a damaged desktop profile is kept under another name and the client continues with empty data', async t => {
  const { profile, file } = await fixture(t);
  t.mock.method(console, 'warn', () => {});
  for (const original of ['{"saved":', '[]', 'null', '']) {
    await writeFile(file, original);
    const call = await createLocalServices(profile, {}, {});
    assert.equal(await call('readClientPersistence', { key: 'saved' }), null);
    await call('writeClientPersistence', { key: 'new', value: '1' });
    assert.equal(await call('readClientPersistence', { key: 'new' }), '1');
    const kept = (await readdir(profile)).filter(name => name.startsWith(`${path.basename(file)}.damaged-`));
    assert.equal(kept.length, 1);
    assert.equal(await readFile(path.join(profile, kept[0]), 'utf8'), original);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { new: '1' });
    await rm(path.join(profile, kept[0]));
  }
});

test('a profile that cannot be read is preserved and reported, not replaced', async t => {
  const { profile, file } = await fixture(t);
  await mkdir(file);
  const call = await createLocalServices(profile, {}, {});
  await assert.rejects(call('writeClientPersistence', { key: 'new', value: '1' }), /profile|设置/i);
  await assert.rejects(call('readClientPersistence', { key: 'new' }), /profile|设置/i);
  assert.deepEqual(await readdir(profile), [path.basename(file)]);
  assert.deepEqual(await readdir(file), []);
});

test('a failed profile save is not visible in memory or on a later successful save', async t => {
  const { profile, file } = await fixture(t);
  await writeFile(file, JSON.stringify({ kept: 'old' }));
  const call = await createLocalServices(profile, {}, {});
  assert.equal(await call('readClientPersistence', { key: 'kept' }), 'old');
  const saved = path.join(profile, 'saved');
  await rename(file, saved); await mkdir(file);
  await assert.rejects(call('writeClientPersistence', { key: 'phantom', value: 'never committed' }));
  assert.equal(await call('readClientPersistence', { key: 'phantom' }), null);
  await rmdir(file); await rename(saved, file);
  const writes = Array.from({ length: 12 }, (_, i) => call('writeClientPersistence', { key: `slot${i}`, value: i }));
  await Promise.all(writes);
  const reopened = await createLocalServices(profile, {}, {});
  const all = await reopened('readManyClientPersistence', { include: [''] });
  assert.deepEqual(all, { kept: 'old', ...Object.fromEntries(writes.map((_, i) => [`slot${i}`, i])) });
  assert.deepEqual(await readdir(profile), [path.basename(file)]);
});

test('the desktop about dialog reports the running application, not a hard-coded vendor release', async t => {
  const { profile } = await fixture(t);
  for (const appVersion of ['0.71.2', '9.4.2']) {
    const call = await createLocalServices(profile, {}, { appVersion });
    const status = await call('getUpdateStatus');
    assert.equal(status.currentVersion, appVersion);
    assert.equal(status.state.type, 'disabled');
  }
});
