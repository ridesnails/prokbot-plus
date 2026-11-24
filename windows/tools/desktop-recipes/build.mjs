#!/usr/bin/env node
// Maintainer tool: regenerate the desktop recipes (Windows x64, macOS arm64, macOS x64,
// Linux x64, Linux arm64) from the official installer and the anchored edits in spec.mjs.
// Every anchor must occur exactly once in its source; unchanged original bytes become copy
// ranges, so a recipe adds only this project's code.
//
//   node windows/tools/desktop-recipes/build.mjs [--target windows|mac-arm64|mac-x64|linux-x64|linux-arm64] [--source <installer|app|deb>] [--check]
//
// Without --source the pinned installer is downloaded and verified like patch.mjs does.
// --check rebuilds in memory and fails unless the committed recipes say the same thing. gzip output
// differs between zlib builds, so recipes compare decompressed and the manifest pins the committed bytes.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, constants } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { applyByteRecipe } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { unpackOriginal } from '../../patchers/desktop/original.mjs';
import { SPEC, buildSpec } from './spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowsRoot = path.resolve(here, '../..');
const repo = path.resolve(windowsRoot, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const TARGET_DIRS = {
  windows: path.join(repo, 'windows/patchers/desktop'),
  'mac-arm64': path.join(repo, 'mac/patchers/desktop'),
  'mac-x64': path.join(repo, 'mac/patchers/desktop/x64'),
  'linux-x64': path.join(repo, 'linux/patchers/desktop'),
  'linux-arm64': path.join(repo, 'linux/patchers/desktop/arm64'),
};

function unique(source, anchor, label) {
  const needle = Buffer.from(anchor, 'utf8');
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`${label}: anchor not found: ${anchor.slice(0, 120)}`);
  if (source.indexOf(needle, at + 1) >= 0) throw new Error(`${label}: anchor not unique: ${anchor.slice(0, 120)}`);
  return { at, end: at + needle.length };
}

// A replacement keeps the original bytes it shares with the anchor at either end.
function trimmed(source, at, end, text) {
  const before = source.subarray(at, end), after = Buffer.from(text, 'utf8');
  let head = 0, tail = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  while (tail < before.length - head && tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return [at + head, end - tail, after.subarray(head, after.length - tail)];
}

/** Turn one spec entry into a grokbot-bytepatch/v1 recipe over its pinned source. */
export function buildRecipe(entry, source) {
  const label = entry.path, changes = [];
  for (const edit of entry.edits) {
    if ('replaceAll' in edit) changes.push([0, source.length, Buffer.from(edit.replaceAll)]);
    else if ('prepend' in edit) changes.push([0, 0, Buffer.from(edit.prepend)]);
    else if ('append' in edit) changes.push([source.length, source.length, Buffer.from(edit.append)]);
    else if ('cutFrom' in edit) { const { at } = unique(source, edit.cutFrom, label); changes.push([at, source.length, Buffer.from(edit.text ?? '')]); }
    else if ('insertAfter' in edit) { const { end } = unique(source, edit.insertAfter, label); changes.push([end, end, Buffer.from(edit.text)]); }
    else if ('insertBefore' in edit) { const { at } = unique(source, edit.insertBefore, label); changes.push([at, at, Buffer.from(edit.text)]); }
    else if ('replace' in edit) { const { at, end } = unique(source, edit.replace, label); changes.push(trimmed(source, at, end, edit.text)); }
    else if ('removeThrough' in edit) {
      const from = unique(source, edit.removeThrough[0], label), to = unique(source, edit.removeThrough[1], label);
      changes.push([from.at, to.end, Buffer.from(edit.text ?? '')]);
    } else throw new Error(`${label}: unknown edit`);
  }
  // Edits at one offset keep their spec order (for example two insertions at the start).
  changes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (let i = 1; i < changes.length; i++) if (changes[i][0] < changes[i - 1][1]) throw new Error(`${label}: overlapping edits`);
  const ops = []; let cursor = 0, added = 0;
  const copy = (from, to) => {
    if (to <= from) return;
    const last = ops.at(-1);
    if (last?.[0] === 'copy' && last[1] + last[2] === from) last[2] += to - from; else ops.push(['copy', from, to - from]);
  };
  const add = bytes => {
    if (!bytes.length) return;
    added += bytes.length;
    const last = ops.at(-1);
    if (last?.[0] === 'add') last[1] = Buffer.concat([Buffer.from(last[1], 'base64'), bytes]).toString('base64');
    else ops.push(['add', bytes.toString('base64')]);
  };
  for (const [start, end, bytes] of changes) { copy(cursor, start); add(bytes); cursor = Math.max(cursor, end); }
  copy(cursor, source.length);
  const target = Buffer.concat(ops.map(op => op[0] === 'copy' ? source.subarray(op[1], op[1] + op[2]) : Buffer.from(op[1], 'base64')));
  const recipe = { schema: 'grokbot-bytepatch/v1', sourceBytes: source.length, sourceSha256: sha(source),
    targetBytes: target.length, targetSha256: sha(target), ops };
  if (!applyByteRecipe(source, recipe).equals(target)) throw new Error(`${label}: recipe does not replay`);
  return { recipe, target, added };
}

/** Build every recipe file and the manifest from an extracted original app.asar. */
export async function buildRecipes(unpacked, spec = SPEC) {
  const files = new Map(), entries = [];
  const sorted = [...spec].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const [index, entry] of sorted.entries()) {
    const source = entry.source === null ? Buffer.alloc(0) : await readFile(path.join(unpacked, entry.source));
    const { recipe, target, added } = buildRecipe(entry, source);
    const name = `${String(index).padStart(3, '0')}.gbp.gz`;
    const compressed = gzipSync(JSON.stringify(recipe), { level: constants.Z_BEST_COMPRESSION });
    files.set(name, compressed);
    entries.push({ path: entry.path, source: entry.source, newFile: entry.source !== entry.path, recipe: name,
      sha256: sha(compressed), targetBytes: target.length, addedBytes: added });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify({ schema: 'grokbot-desktop-recipes/v1', files: entries }, null, 2) + '\n'));
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const target = arg('--target') ?? 'windows';
  const desktop = TARGET_DIRS[target];
  if (!desktop) throw new Error(`Unknown --target: ${target}`);
  const recipes = path.join(desktop, 'recipes');
  const supported = JSON.parse(await readFile(path.join(desktop, 'supported.json'), 'utf8'));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-recipes-'));
  let mounted = null;
  try {
    const isMac = target.startsWith('mac-');
    const isLinux = target.startsWith('linux-');
    const cacheRoot = isMac ? path.join(repo, 'mac/.cache') : isLinux ? path.join(repo, 'linux/.cache') : path.join(windowsRoot, '.cache');
    const source = await acquireDesktopSource({ source: arg('--source'), cacheDirectory: cacheRoot, supported,
      onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} (${target})…`) });
    let asarFile;
    if (isMac) {
      let app = source;
      if (path.extname(source).toLowerCase() === '.dmg') {
        if (process.platform !== 'darwin') {
          throw new Error('Mounting a macOS .dmg requires macOS (hdiutil); on Windows/Linux pass --source <path/to/Grok Bot.app> instead.');
        }
        mounted = path.join(temporary, 'mount');
        await mkdir(mounted);
        execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mounted, source], { stdio: 'ignore' });
        app = path.join(mounted, 'Grok Bot.app');
      }
      asarFile = path.join(app, 'Contents/Resources/app.asar');
    } else if (isLinux) {
      // Loaded here because the Windows, Android and web packages ship without linux/.
      const { unpackOriginal: unpackLinuxOriginal } = await import('../../../linux/patchers/desktop/deb.mjs');
      const app = await unpackLinuxOriginal(source, temporary, supported);
      asarFile = path.join(app, 'resources/app.asar');
    } else {
      const app = await unpackOriginal(source, temporary, supported);
      asarFile = path.join(app, 'resources/app.asar');
    }
    if (sha(await readFile(asarFile)) !== supported.asarSha256) throw new Error(`Not the pinned Grok Bot ${supported.version} (${target}) app.asar`);
    const asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar');
    const unpacked = path.join(temporary, 'app');
    asar.extractAll(asarFile, unpacked);
    const files = await buildRecipes(unpacked, buildSpec(target));
    if (args.includes('--check')) {
      const committed = (await readdir(recipes)).sort();
      const stale = [...files.keys()].filter(name => !committed.includes(name)).concat(committed.filter(name => !files.has(name)));
      const pinned = JSON.parse(await readFile(path.join(recipes, 'manifest.json'), 'utf8'));
      const unpinned = manifest => JSON.stringify([manifest.schema, manifest.files.map(({ sha256, ...entry }) => entry)]);
      for (const [name, bytes] of files) {
        if (!committed.includes(name)) continue;
        const saved = await readFile(path.join(recipes, name));
        const same = name === 'manifest.json' ? unpinned(JSON.parse(bytes)) === unpinned(pinned)
          : gunzipSync(bytes).equals(gunzipSync(saved)) && pinned.files.find(entry => entry.recipe === name)?.sha256 === sha(saved);
        if (!same) stale.push(name);
      }
      if (stale.length) throw new Error(`Committed recipes differ from spec.mjs (${target}): ${stale.join(', ')}`);
    } else {
      await mkdir(recipes, { recursive: true });
      for (const name of await readdir(recipes)) if (/^\d{3}\.gbp\.gz$|^manifest\.json$/.test(name)) await rm(path.join(recipes, name));
      for (const [name, bytes] of files) await writeFile(path.join(recipes, name), bytes);
    }
    console.log(JSON.stringify({ target, version: supported.version, recipes: files.size - 1, checked: args.includes('--check') }));
  } finally {
    if (mounted) { try { execFileSync('hdiutil', ['detach', mounted], { stdio: 'ignore' }); } catch {} }
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
