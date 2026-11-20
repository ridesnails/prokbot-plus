// Offline maintenance check: report what the build tools actually pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { inspectRecipe } from './recipe-pin.mjs';
import { windowsInputs, windowsReleases } from '../windows/patchers/desktop/inputs.mjs';
import { readZip } from '../android/patchers/apk.mjs';
import { verifyShellVersion } from '../android/patchers/shell-version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = file => readFile(join(root, file));
const json = async file => JSON.parse(await bytes(file));
const sha = async file => createHash('sha256').update(await bytes(file)).digest('hex');
async function checkRecipes(dir, records, key, sources) {
  assert.ok(records.length, `${dir}: empty recipe manifest`);
  const pins = new Map();
  for (const item of records) {
    assert.match(item[key], /^[\w.-]+\.gz$/);
    const buffer = await bytes(`${dir}/${item[key]}`);
    const target = item.path ?? item.target;
    assert.ok(typeof target === 'string' && !pins.has(target), `duplicate or missing recipe target: ${target}`);
    const sourcePin = typeof sources === 'string' ? sources : sources?.[item.source];
    if (sources) assert.match(sourcePin ?? '', /^[0-9a-f]{64}$/);
    pins.set(target, inspectRecipe(buffer, `${dir}/${item[key]}`, item, sourcePin));
  }
  return pins;
}
const host = await json('host/recipes/host/manifest.json');
await checkRecipes('host/recipes/host', host.files, 'patch', host.sourceSha256);
assert.match(host.archive.sha256, /^[0-9a-f]{64}$/);
for (const key of ['manifestDigest', 'configDigest']) assert.match(host.box[key], /^sha256:[0-9a-f]{64}$/);
const dockerfile = (await bytes('host/release/Dockerfile.host')).toString().split(/\r?\n/);
const runtimeArgs = dockerfile.filter(line => /^ARG RUNTIME_IMAGE(?:=|$)/.test(line));
assert.equal(runtimeArgs.length, 1, 'missing or ambiguous runtime image argument');
assert.ok(runtimeArgs[0] === `ARG RUNTIME_IMAGE=${host.box.localTag}` || runtimeArgs[0] === 'ARG RUNTIME_IMAGE',
  'stale default desktop base in Dockerfile.host');
assert.ok(dockerfile.includes('FROM ${RUNTIME_IMAGE}'), 'Dockerfile does not use the selected runtime');
const builder = (await bytes('host/release/build-docker.py')).toString();
assert.ok(builder.includes("'--build-arg', f'RUNTIME_IMAGE={runtime_image}'") && builder.includes('choose_runtime(platform, args.host_only)'),
  'Host builder must explicitly pass the runtime chosen for its platform and mode');
for (const file of ['compose.yaml', 'compose.execution.yaml']) {
  const compose = (await bytes(`host/release/${file}`)).toString();
  assert.ok(compose.includes('${GROKBOT_BOX_IMAGE:-' + host.box.localTag + '}'), `stale desktop tag in ${file}`);
  assert.ok(compose.split('\n  box:\n')[1]?.includes(`platform: ${host.box.platform}`), `wrong desktop platform in ${file}`);
}
const versions = { host: host.archive.version, desktop: `${host.box.localTag} (${host.box.platform})` };
async function checkDesktop(dir) {
  const original = await json(`${dir}/supported.json`);
  assert.match(original.archive.sha256, /^[0-9a-f]{64}$/);
  const list = (await json(`${dir}/recipes/manifest.json`)).files;
  const pins = await checkRecipes(`${dir}/recipes`, list, 'recipe');
  // Windows 1.1.0 keeps the original preload, which the archive digest already pins.
  const preload = pins.get('dist/electron-preload/preload.cjs');
  if (preload) assert.equal(preload.input, original.preloadSha256, `${dir}: stale preload source`);
  const policy = await json(`${dir}/notification-policy.json`);
  const source = list.find(item => item.source === policy.source);
  assert.ok(source, `${dir}: missing notification policy source`);
  assert.equal(pins.get(source.path).input, policy.sourceSha256, `${dir}: stale notification policy source`);
  return { original, pins };
}
const desktopPins = {};
for (const name of ['mac', 'windows']) {
  const { original, pins } = await checkDesktop(`${name}/patchers/desktop`);
  desktopPins[`${name}/patchers/desktop`] = { original, pins };
  versions[name] = original.version;
}
// The Intel macOS build of the same version, with recipes ported from the Apple silicon ones.
{
  const dir = 'mac/patchers/desktop/x64';
  const { original, pins } = await checkDesktop(dir);
  const arm = desktopPins['mac/patchers/desktop'];
  assert.equal(original.architecture, 'x64');
  for (const key of ['version', 'bundleId', 'preloadSha256']) assert.equal(original[key], arm.original[key], `${dir}: ${key} differs from Apple silicon`);
  assert.deepEqual([...pins.keys()].map(target => target.replace(/-[\w-]{8}\.js$/, '.js')),
    [...arm.pins.keys()].map(target => target.replace(/-[\w-]{8}\.js$/, '.js')), `${dir}: recipe targets differ from Apple silicon`);
  desktopPins[dir] = { original, pins };
  versions.macIntel = original.version;
}
// Older Windows releases the patch still builds (the fallback), each in a directory named after its version.
const windowsFallback = [];
for (const { directory, supported } of (await windowsReleases()).slice(1)) {
  const dir = relative(root, directory).replaceAll('\\', '/');
  desktopPins[dir] = await checkDesktop(dir);
  windowsFallback.push(supported.version);
}
versions.windowsFallback = windowsFallback;
const android = await json('android/patchers/supported.json');
for (const build of [android, ...(android.fallback ?? [])]) {
  const dir = relative(root, (await windowsInputs(build.desktopVersion)).directory).replaceAll('\\', '/');
  const { original, pins } = desktopPins[dir] ?? (desktopPins[dir] = await checkDesktop(dir));
  const where = `Android interface ${build.desktopVersion}`;
  assert.equal(pins.get('dist/renderer/index.html')?.output, build.rendererIndexSha256, `${where}: stale renderer index`);
  assert.equal(pins.get('dist/electron-preload/preload.cjs')?.output ?? original.preloadSha256, build.preloadSha256, `${where}: stale preload`);
  assert.match(build.vncPreloadSha256, /^[0-9a-f]{64}$/);
}
assert.equal(await sha(android.shell.path), android.shell.sha256, 'Android shell digest mismatch');
const shell = verifyShellVersion(readZip(await bytes(android.shell.path)).entries, android.shell);
const ios = await json('ios/recipes/ios/manifest.json');
await checkRecipes('ios/recipes/ios', ios.resources, 'patch', ios.hbcSha256);
assert.equal(await sha('ios/bin/GrokBotLocal.dylib'), ios.dylibSha256, 'iOS injected library digest mismatch');
console.log(JSON.stringify({ ...versions, androidShell: `${shell.versionName} (${shell.versionCode})`, androidRenderer: [android.desktopVersion, ...(android.fallback ?? []).map(item => item.desktopVersion)].join(', '), ios: `${ios.version} (${ios.build})` }, null, 2));
