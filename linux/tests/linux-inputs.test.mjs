import test from 'node:test';
import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const linuxRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(linuxRoot, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(path.join(linuxRoot, file), 'utf8'));

const builds = [
  { arch: 'x64', inputs: 'patchers/desktop', tailcat: 'host/bin/grokbot-tailcat', machine: 0x3e, debSuffix: '_amd64.deb', urlSegment: '/linux/x64/' },
  { arch: 'arm64', inputs: 'patchers/desktop/arm64', tailcat: 'host/bin/linux-arm64/grokbot-tailcat', machine: 0xb7, debSuffix: '_arm64.deb', urlSegment: '/linux/arm64/' },
];

async function elfHeader(file) {
  const handle = await open(path.join(repoRoot, file), 'r');
  try {
    const bytes = Buffer.alloc(20);
    await handle.read(bytes, 0, 20, 0);
    return bytes;
  } finally {
    await handle.close();
  }
}

test('each Linux build has its own pinned .deb, recipes and ELF Tailcat for its CPU', async () => {
  for (const build of builds) {
    const supported = await json(`${build.inputs}/supported.json`);
    assert.equal(supported.architecture, build.arch);
    assert.ok(supported.archive.url.includes(build.urlSegment), build.arch);
    assert.ok(supported.archive.url.endsWith(build.debSuffix), build.arch);
    for (const key of ['exeSha256', 'asarSha256', 'asarHeaderSha256', 'preloadSha256']) {
      assert.match(supported[key], /^[0-9a-f]{64}$/, `${build.arch} ${key}`);
    }
    assert.match(supported.archive.sha256, /^[0-9a-f]{64}$/);
    assert.match(supported.payload.sha256, /^[0-9a-f]{64}$/);
    const manifest = await json(`${build.inputs}/recipes/manifest.json`);
    for (const entry of manifest.files) {
      assert.equal(sha(await readFile(path.join(linuxRoot, build.inputs, 'recipes', entry.recipe))), entry.sha256, entry.path);
    }
    await readFile(path.join(linuxRoot, build.inputs, 'notification-policy.json'));
    const header = await elfHeader(build.tailcat);
    assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', `${build.tailcat} is not an ELF binary`);
    assert.equal(header[4], 2, `${build.tailcat} is not 64-bit ELF`);
    assert.equal(header[5], 1, `${build.tailcat} is not little-endian ELF`);
    assert.equal(header.readUInt16LE(18), build.machine, `${build.tailcat} is built for another CPU`);
  }
});

test('the ARM64 Linux recipes add the same code as the x64 Linux recipes', async () => {
  const [x64, arm64] = await Promise.all(builds.map(build => json(`${build.inputs}/recipes/manifest.json`)));
  assert.equal(arm64.files.length, x64.files.length);
  const mask = text => text.replace(/-[\w-]{8}(\.(?:js|css|svg|png|wav|mp3|webp|woff2?|json|wasm))/g, '-HASHHASH$1');
  const summarize = async (inputs, manifest) => (await Promise.all(manifest.files.map(async entry => {
    const added = JSON.parse(gunzipSync(await readFile(path.join(linuxRoot, inputs, 'recipes', entry.recipe))))
      .ops.filter(op => op[0] === 'add').map(op => mask(Buffer.from(op[1], 'base64').toString('utf8')));
    return { path: mask(entry.path), added };
  }))).sort((a, b) => a.path.localeCompare(b.path) || JSON.stringify(a.added).localeCompare(JSON.stringify(b.added)));
  assert.deepEqual(await summarize(builds[1].inputs, arm64), await summarize(builds[0].inputs, x64));
});
