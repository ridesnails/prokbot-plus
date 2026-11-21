import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { previousImageLink, provisionResources } from '../runtime/host-resources.mjs';
import { checkDeploymentHealth } from '../deploy/healthcheck.mjs';
import { HostSupervisor } from '../deploy/host-supervisor.mjs';

for (const [script, name] of [['deployment_checks.py', 'deployment platform and mode selection'],
  ['deployment_identity.py', 'same-daemon recovery identity and shared image-tag transactions'],
  ['deployment_data.py', 'Host data tree initialization'],
  ['deployment_volumes.py', 'isolated upgrade, archive round trips and fail-closed recovery']]) test(name, () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-B', fileURLToPath(new URL(script, import.meta.url))], { encoding: 'utf8', timeout: 90_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('remote Host health follows the same execution-node setup gate as its supervisor', async t => {
  const data = await mkdtemp(join(tmpdir(), 'host-health-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const requests = [];
  const admin = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(req.url === '/healthz' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url === '/healthz' }));
  });
  await new Promise(resolve => admin.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); }));
  const env = { GROKBOT_PORT: String(admin.address().port), GROKBOT_DATA_DIR: data, GROKBOT_REQUIRE_EXECUTION_NODE: '1',
    GROKBOT_INTERNAL_HOST_URL: `http://127.0.0.1:${admin.address().port}` };
  await writeFile(join(data, 'model.env'), 'OPENAI_BASE_URL=fixture\nOPENAI_API_KEY=fixture\nOPENAI_MODEL=fixture\n');
  const nodeFile = join(data, 'execution-node.json');
  assert.equal(await checkDeploymentHealth(env), true, 'execution node has not been configured yet');
  await writeFile(nodeFile, JSON.stringify({ version: 1, config: { enabled: false } }));
  assert.equal(await checkDeploymentHealth(env), true);
  assert.deepEqual(requests, ['/healthz', '/healthz']);
  await writeFile(nodeFile, JSON.stringify({ version: 1, config: { enabled: true } }));
  assert.equal(await checkDeploymentHealth(env), false, 'a configured deployment must not mask a missing Host');
  await writeFile(nodeFile, '{');
  assert.equal(await checkDeploymentHealth(env), false, 'unreadable configuration is not a setup state');
});

test('shutdown while writing startup status must not spawn a new Host', async t => {
  const data = await mkdtemp(join(tmpdir(), 'host-shutdown-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const supervisor = new HostSupervisor({ dataDir: data, isConfigured: async () => true });
  let writing, finish;
  const began = new Promise(resolve => { writing = resolve; });
  const flushed = new Promise(resolve => { finish = resolve; });
  supervisor.status = async () => { writing(); await flushed; };
  let starts = 0;
  supervisor.startHost = () => { starts++; };
  supervisor.start();
  await began;
  const stopped = supervisor.stop();
  finish();
  await stopped;
  assert.equal(starts, 0);
});

test('only resource links from a sibling image revision belong to the updater', () => {
  const root = resolve('artifacts'), current = join(root, 'host-abc', 'sand-host');
  assert.ok(previousImageLink(join(root, 'host-def', 'sand-host', 'version'), current, 'version'));
  for (const target of [join(current, 'version'), join(root, 'host-def', 'sand-host', 'other'),
    join(root, 'user', 'sand-host', 'version'), resolve('other', 'host-def', 'sand-host', 'version')]) {
    assert.equal(previousImageLink(target, current, 'version'), false);
  }
});

test('refreshes a dangling image link but preserves user files and links', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, 'host-abc', 'sand-host'), state = join(root, 'state');
  await mkdir(src, { recursive: true }); await mkdir(state);
  for (const name of ['version', 'data', 'link']) await writeFile(join(src, name), 'new');
  await symlink(join(root, 'host-def', 'sand-host', 'version'), join(state, 'version'));
  await writeFile(join(state, 'data'), 'mine'); await symlink(join(state, 'data'), join(state, 'link'));
  await provisionResources(state, src);
  assert.equal(await readFile(join(state, 'version'), 'utf8'), 'new');
  for (const name of ['data', 'link']) assert.equal(await readFile(join(state, name), 'utf8'), 'mine');
});
