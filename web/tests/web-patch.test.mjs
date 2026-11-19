import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BUNDLE_SCHEMA, WEB_TAGS, bundleFiles, bundleZip, webIndexHtml } from '../patchers/patch.mjs';
import { hostOrigin, uploadBundle } from '../patchers/upload.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const CSP = (frames, connect = "connect-src 'self' ws: sand-media: https://grok.com;") =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ${connect} ${frames}" />`;
const page = (frames = 'frame-src sand-html-preview: sand-canvas: sand-mcp-app: sand-visualization:;') =>
  `<!doctype html><html><head>${CSP(frames)}<title>Grok Bot</title>\n    ` +
  '<script type="module" crossorigin src="./assets/index-Demo.js"></script></head><body><div id="root"></div></body></html>';

test('the interface entry gains the web bridge, its own frames and secure realtime connections', () => {
  for (const frames of ['frame-src sand-html-preview: sand-canvas: sand-mcp-app: sand-visualization:;', 'frame-src sand-html-preview: sand-canvas: sand-mcp-app:;']) {
    const html = webIndexHtml(page(frames));
    assert.ok(html.indexOf(WEB_TAGS) < html.indexOf('<script type="module" crossorigin src="./assets/index-'), 'the bridge loads before the interface');
    assert.match(html, /frame-src sand-html-preview: sand-canvas: sand-mcp-app:[a-z: -]* 'self';/);
    assert.match(html, /connect-src 'self' ws: wss: sand-media:/);
    for (const asset of ['../client/boot-data.js', '../client/bridge.js', '../client/web-shell.js', '../client/web.css', '/web/manifest.webmanifest'])
      assert.ok(html.includes(asset), asset);
    assert.ok(html.indexOf('boot-data.js') < html.indexOf('compat.js'), 'start-up data comes first');
  }
  assert.throws(() => webIndexHtml(page().replace('<script type="module" crossorigin src="./assets/index-', '<script src="./other-')), /版本不一致/);
  assert.throws(() => webIndexHtml(page().replace('frame-src', 'child-src')), /版本不一致/);
  assert.throws(() => webIndexHtml(page() + page()), /版本不一致/);
});

async function fakeDist(t) {
  const dist = await mkdtemp(path.join(tmpdir(), 'grokbot-web-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(path.join(dist, 'renderer/assets'), { recursive: true });
  await writeFile(path.join(dist, 'renderer/index.html'), webIndexHtml(page()));
  await writeFile(path.join(dist, 'renderer/assets/index-Demo.js'), 'export {};\n');
  return dist;
}

test('the bundle carries the interface, the shared bridge and the browser layer, with a manifest of every file', async t => {
  const build = { rendererVersion: '1.1.0', recommended: true, sourceAsarSha256: 'a'.repeat(64), builtAt: '2026-01-01T00:00:00.000Z' };
  const files = await bundleFiles({ dist: await fakeDist(t), preload: 'module.exports = {};', vncPreload: 'module.exports = {};',
    icon: Buffer.from('demo-icon'), build });
  for (const name of ['renderer/index.html', 'renderer/assets/index-Demo.js', 'client/bridge.js', 'client/gateway.js', 'client/vnc-bridge.js',
    'client/android.css', 'client/boot-data.js', 'client/web-shell.js', 'client/web.css', 'client/desktop/workspace.css',
    'client/desktop/workspace-keys.js', 'client/official-preload.js', 'client/vnc-preload.js', 'client/icon.png', 'client/build.json'])
    assert.ok(files.has(name), name);
  // The Android shell's own pages stay out; the browser's native layer replaces the shell's.
  for (const name of ['client/connect.html', 'client/connect.js', 'client/connect.css']) assert.equal(files.has(name), false, name);
  assert.deepEqual(files.get('client/native.js'), await readFile(path.join(repo, 'web/client/native.js')));

  const { zip, manifest } = bundleZip(files, build);
  assert.equal(manifest.schema, BUNDLE_SCHEMA);
  assert.equal(zip.subarray(30, 30 + 'web-bundle.json'.length).toString(), 'web-bundle.json', 'the manifest is the first entry');
  assert.deepEqual(Object.keys(manifest.files), [...files.keys()].sort((a, b) => a.localeCompare(b)));
  for (const [name, bytes] of files) assert.deepEqual(manifest.files[name], { bytes: bytes.length, sha256: sha(bytes) });

  // The Host accepts exactly what the generator writes (host/ is not part of the web tool package).
  const host = path.join(repo, 'host/server/web-client.mjs');
  if (!existsSync(host)) return t.diagnostic('host/server/web-client.mjs not present; Host acceptance not checked');
  const { readBundleZip, verifyBundle, BUNDLE_SCHEMA: hostSchema } = await import('../../host/server/web-client.mjs');
  assert.equal(hostSchema, BUNDLE_SCHEMA);
  assert.equal(verifyBundle(readBundleZip(zip)).rendererVersion, '1.1.0');
});

test('uploading signs in, installs, enables and signs out without putting the password on the command line', async t => {
  assert.equal(hostOrigin('https://host.example:8443/admin?view=web-client'), 'https://host.example:8443');
  assert.throws(() => hostOrigin('ftp://host.example'), /http/);
  assert.throws(() => hostOrigin('https://user:secret@host.example'), /用户名和密码/);
  assert.throws(() => hostOrigin('host.example'), /地址无效/);

  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push([request.method, request.url, request.headers['x-grokbot-csrf'], request.headers.cookie ?? null,
      request.url === '/admin/api/web-client' && request.method === 'PUT' ? body.length : body.toString()]);
    const reply = (status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
    if (request.url === '/admin/api/login')
      return JSON.parse(body).password === 'demo' ? reply(200, { ok: true }, { 'set-cookie': 'grokbot_admin=session; Path=/; HttpOnly' }) : reply(401, { error: '管理员密码不正确' });
    if (request.url === '/admin/api/web-client' && request.method === 'PUT') return reply(200, { installed: true, enabled: false });
    if (request.url === '/admin/api/web-client' && request.method === 'PATCH') return reply(200, { installed: true, enabled: true });
    reply(200, { ok: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;

  assert.deepEqual(await uploadBundle(address, Buffer.from('zip-bytes'), 'demo'), { installed: true, enabled: true });
  assert.deepEqual(calls, [
    ['POST', '/admin/api/login', '1', null, '{"password":"demo"}'],
    ['PUT', '/admin/api/web-client', '1', 'grokbot_admin=session', 9],
    ['PATCH', '/admin/api/web-client', '1', 'grokbot_admin=session', '{"enabled":true}'],
    ['POST', '/admin/api/logout', '1', 'grokbot_admin=session', '{}'],
  ]);
  await assert.rejects(uploadBundle(address, Buffer.from('zip-bytes'), 'wrong'), /管理员密码不正确/);
});

// Builds from the pinned official installers when they are available locally; never downloads.
const sources = [process.env.PROKBOT_WEB_TEST_SOURCE ?? process.env.PROKBOT_ANDROID_TEST_SOURCE, process.env.PROKBOT_WEB_TEST_FALLBACK_SOURCE].filter(Boolean);
test('pinned installers verify as web client sources', { skip: !sources.length && 'set PROKBOT_WEB_TEST_SOURCE to a pinned local installer' }, async () => {
  for (const source of sources) {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(repo, 'web/patchers/patch.mjs'), '--source', source, '--verify-only'],
      { cwd: repo, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const result = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(result.verified, true);
    assert.match(result.rendererVersion, /^\d+\.\d+\.\d+$/);
  }
});
