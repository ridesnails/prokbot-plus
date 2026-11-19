#!/usr/bin/env node
// Build the web client bundle that a Host serves at /web/. The interface comes from the user's
// own copy of the official Grok Bot Windows installer (verified against pinned hashes) with the
// ProkBot Plus desktop recipes and the Android interface patches applied, exactly as the Android
// client builds it; the bridge is android/client with the browser layer in web/client. The
// bundle is installed on the user's own Host (admin page, or --upload) and is never published.
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { acquireDesktopSource } from '../../mac/patchers/desktop/download-original.mjs';
import { applicationIcon } from '../../windows/patchers/desktop/pe.mjs';
import { unpackOriginal } from '../../windows/patchers/desktop/original.mjs';
import { selectWindowsRelease } from '../../windows/patchers/desktop/inputs.mjs';
import { withInstallerDiagnostic } from '../../windows/patchers/desktop/input-diagnostic.mjs';
import { androidRenderers, stageAndroidArchive, verifyStagedRenderer, wrapPreload, wrapVncPreload } from '../../android/patchers/patch.mjs';
import { rendererPatches } from '../../android/patchers/renderer-patches.mjs';
import { writeZip, createEntry } from '../../android/patchers/apk.mjs';
import { writeBuildOutput } from '../../android/patchers/output.mjs';
import { uploadBundle, adminPassword } from './upload.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repo = path.resolve(webRoot, '..');
const androidClient = path.join(repo, 'android/client');
const sharedAssets = ['i18n.mjs', 'external-url.mjs', 'connectors.mjs', 'dictation.mjs', 'workspace.css', 'workspace-keys.cjs'];
// The Android shell's own pages and native layer; web/client provides the browser's.
const ANDROID_ONLY = new Set(['connect.html', 'connect.js', 'connect.css', 'native.js']);
export const BUNDLE_SCHEMA = 'grokbot-web-bundle/v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(filename) { return sha(await readFile(filename)); }

export const WEB_TAGS = '<script src="../client/boot-data.js"></script>\n    <script src="../client/compat.js"></script>\n    ' +
  '<script src="../client/desktop/workspace-keys.js"></script>\n    <script type="module" src="../client/bridge.js"></script>\n    ' +
  '<script type="module" src="../client/web-shell.js"></script>\n    <link rel="stylesheet" href="../client/android.css">\n    ' +
  '<link rel="stylesheet" href="../client/desktop/workspace.css">\n    <link rel="stylesheet" href="../client/web.css">\n    ' +
  '<link rel="icon" href="../client/icon.png">\n    <link rel="apple-touch-icon" href="../client/icon.png">\n    ' +
  '<link rel="manifest" href="/web/manifest.webmanifest" crossorigin="use-credentials">\n    ' +
  '<meta name="mobile-web-app-capable" content="yes">\n    <meta name="apple-mobile-web-app-capable" content="yes">\n    ' +
  '<meta name="apple-mobile-web-app-title" content="Grok Bot">\n    ';
const MODULE_ANCHOR = '<script type="module" crossorigin src="./assets/index-';
const FRAME_ANCHOR = /frame-src sand-html-preview: sand-canvas: sand-mcp-app:(?: sand-[a-z-]+:)*;/g;
const CONNECT_ANCHOR = /connect-src 'self' ws: /g;

/**
 * Inserts the bridge ahead of the renderer. The Bot computer view loads from the Host itself
 * (`frame-src 'self'`), and a realtime call over HTTPS needs `wss:` beside the original `ws:`.
 */
export function webIndexHtml(html) {
  const at = html.indexOf(MODULE_ANCHOR), frames = [...html.matchAll(FRAME_ANCHOR)], connects = [...html.matchAll(CONNECT_ANCHOR)];
  if (at < 0 || html.indexOf(MODULE_ANCHOR, at + 1) >= 0 || frames.length !== 1 || connects.length !== 1)
    throw new Error('界面入口与支持的版本不一致。');
  return (html.slice(0, at) + WEB_TAGS + html.slice(at))
    .replace(FRAME_ANCHOR, sources => `${sources.slice(0, -1)} 'self';`)
    .replace(CONNECT_ANCHOR, "connect-src 'self' ws: wss: ");
}

async function listFiles(root, prefix = '') {
  const result = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await listFiles(root, relative));
    else if (item.isFile()) result.push(relative);
  }
  return result.sort();
}

/** The files of the bundle, by path: the patched renderer, the bridge and the copied originals. */
export async function bundleFiles({ dist, preload, vncPreload, icon, build }) {
  const files = new Map();
  const add = (name, bytes) => { if (files.has(name)) throw new Error(`重复的文件：${name}`); files.set(name, Buffer.from(bytes)); };
  for (const name of await listFiles(path.join(dist, 'renderer'))) add(`renderer/${name}`, await readFile(path.join(dist, 'renderer', name)));
  for (const name of await listFiles(androidClient)) if (!ANDROID_ONLY.has(name)) add(`client/${name}`, await readFile(path.join(androidClient, name)));
  for (const name of await listFiles(path.join(webRoot, 'client'))) add(`client/${name}`, await readFile(path.join(webRoot, 'client', name)));
  for (const name of sharedAssets)
    add(`client/desktop/${name.replace(/\.cjs$/, '.js')}`, await readFile(path.join(repo, 'mac/clients/desktop', name)));
  add('client/official-preload.js', wrapPreload(preload));
  add('client/vnc-preload.js', wrapVncPreload(vncPreload));
  add('client/icon.png', icon);
  add('client/build.json', JSON.stringify(build));
  return files;
}

/** A ZIP whose first entry, web-bundle.json, lists every other file with its size and SHA-256. */
export function bundleZip(files, build) {
  const manifest = { schema: BUNDLE_SCHEMA, ...build,
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) };
  const entries = [createEntry('web-bundle.json', JSON.stringify(manifest, null, 2))];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) entries.push(createEntry(name, bytes));
  return { zip: writeZip(entries), manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const build = JSON.parse(await readFile(path.join(repo, 'android/patchers/supported.json'), 'utf8'));
  const renderers = androidRenderers(build), accepted = renderers.map(renderer => renderer.desktopVersion);
  if (args.includes('--help')) {
    const [recommended, ...older] = accepted;
    console.log(`node web/patchers/patch.mjs [--source <Grok_Bot_${recommended}_Setup.exe | app-64.7z | 安装目录>] [--version <${accepted.join('|')}>]
    [--output <目录>] [--force] [--verify-only] [--upload <Host 地址>] [--password-file <文件>]
生成网页版界面包；界面推荐取自 Windows ${recommended}${older.length ? `，${recommended} 用不了时再用 ${older.join('、')}` : ''}。
--source 指定的官方 Windows 原版按摘要自动识别版本；省略 --source 时自动下载并校验 ${recommended}（或 --version 指定的版本）Windows x64 安装包。
--verify-only 在临时目录验证原包、Windows recipe、网页入口和界面补丁，不生成文件。
--upload 生成后用管理员密码登录 Host，把界面包安装到 Host 上；密码取自 GROKBOT_ADMIN_PASSWORD、--password-file，或在终端输入。
默认输出到 web/output/GrokBotLocal-web-<版本>.zip，也可以在管理页「网页版」里上传。`);
    return;
  }
  const verifyOnly = args.includes('--verify-only');
  const uploadTo = arg('--upload');
  // Ask for the password before the long build, so an unattended upload does not wait at the end.
  const password = uploadTo && !verifyOnly ? await adminPassword(arg('--password-file')) : null;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grokbot-web-patch-'));
  try {
    const explicitSource = arg('--source');
    const { directory: windowsDesktop, supported } = await selectWindowsRelease({ source: explicitSource, version: arg('--version'), accepted });
    const renderer = renderers.find(item => item.desktopVersion === supported.version);
    const source = await acquireDesktopSource({ source: explicitSource, cacheDirectory: verifyOnly ? path.join(temporary, 'download') : path.join(webRoot, '.cache'), supported,
      onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Windows x64 安装包（网页版使用其中的界面）…`) });
    const app = await withInstallerDiagnostic(unpackOriginal(source, temporary, supported), explicitSource && source, supported, accepted);
    const originalExe = path.join(app, 'Grok Bot.exe'), originalAsar = path.join(app, 'resources/app.asar');
    const asarSha256 = await hashFile(originalAsar);
    if (await hashFile(originalExe) !== supported.exeSha256 || asarSha256 !== supported.asarSha256)
      throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} Windows ${supported.architecture}；程序或 ASAR 摘要不匹配。`);
    let asar;
    try { asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar'); }
    catch { throw new Error('缺少 @electron/asar；执行 npm install --prefix mac/patchers/desktop。'); }
    const unpacked = path.join(temporary, 'app');
    const patches = rendererPatches(renderer.desktopVersion);
    const windowsRecipes = await stageAndroidArchive(asar, originalAsar, unpacked, path.join(windowsDesktop, 'recipes'), verifyOnly, patches);
    const dist = path.join(unpacked, 'dist');
    const { preload, vncPreload } = await verifyStagedRenderer(dist, renderer, patches, webIndexHtml);
    const recommended = renderer.desktopVersion === accepted[0];
    const checks = { windowsRecipes, rendererPatches: patches.length };
    if (verifyOnly) {
      console.log(JSON.stringify({ verified: true, rendererVersion: renderer.desktopVersion, recommended, asarSha256, checks }));
      return;
    }
    const outputRoot = path.resolve(arg('--output') ?? path.join(webRoot, 'output'));
    const zipPath = path.join(outputRoot, `GrokBotLocal-web-${renderer.desktopVersion}.zip`);
    const force = args.includes('--force');
    const within = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith('..') && !path.isAbsolute(relative); };
    if (within(path.resolve(source), zipPath)) throw new Error(`输出位置与输入重叠：${zipPath}`);
    const info = { rendererVersion: renderer.desktopVersion, recommended, sourceAsarSha256: asarSha256, builtAt: new Date().toISOString() };
    const files = await bundleFiles({ dist, preload, vncPreload, icon: applicationIcon(await readFile(originalExe)).png, build: info });
    const { zip, manifest } = bundleZip(files, info);
    await writeBuildOutput(outputRoot, [{ target: zipPath, bytes: zip }], force);
    console.log(JSON.stringify({ output: zipPath, ...info, files: Object.keys(manifest.files).length, bytes: zip.length, sha256: sha(zip), checks }, null, 2));
    if (uploadTo) {
      const result = await uploadBundle(uploadTo, zip, password);
      console.log(JSON.stringify({ uploaded: true, host: new URL(uploadTo).origin, webClient: result }, null, 2));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
