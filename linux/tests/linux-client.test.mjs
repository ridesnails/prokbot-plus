import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDebPayload, listArEntries } from '../patchers/desktop/deb.mjs';
import { apparmorProfile, desktopEntry, installScript, launcherScript, setupAppArmorScript, uninstallScript } from '../patchers/desktop/launcher.mjs';
import { connectWindowChrome, createTray, windowChrome, windowHandlers } from '../../mac/clients/desktop/platform.mjs';
import { credentialUnavailableText, ensureCredentialEncryption } from '../../mac/clients/desktop/connection.mjs';
import { machineIdForPlatform } from '../../mac/clients/desktop/local-exec.mjs';
import { spawnSoundPlayer } from '../../mac/clients/desktop/sounds.mjs';
import { setLocaleSource } from '../../mac/clients/desktop/i18n.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function makeAr(members) {
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  for (const [name, data] of members) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.alloc(60, 0x20);
    header.write(name.slice(0, 16), 0, 'ascii');
    header.write('0', 16, 'ascii');
    header.write('0', 28, 'ascii');
    header.write('0', 34, 'ascii');
    header.write('100644', 40, 'ascii');
    header.write(String(buf.length), 48, 'ascii');
    header[58] = 0x60;
    header[59] = 0x0a;
    parts.push(header, buf);
    if (buf.length % 2 === 1) parts.push(Buffer.from('\n', 'ascii'));
  }
  return Buffer.concat(parts);
}

test('deb ar parser verifies both the outer .deb and embedded data archive digests', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-deb-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = Buffer.from('synthetic-data-tar-xz-bytes');
  const debBytes = makeAr([
    ['debian-binary/', '2.0\n'],
    ['control.tar.xz/', 'ctrl'],
    ['data.tar.xz/', payload],
  ]);
  const debFile = path.join(dir, 'fixture.deb');
  await writeFile(debFile, debBytes);
  const entries = await listArEntries(debFile);
  assert.deepEqual([...entries.keys()], ['debian-binary', 'control.tar.xz', 'data.tar.xz']);
  const supported = {
    version: '1.2.3',
    architecture: 'x64',
    archive: { bytes: debBytes.length, sha256: sha(debBytes) },
    payload: { name: 'data.tar.xz', bytes: payload.length, sha256: sha(payload) },
  };
  const out = path.join(dir, 'data.tar.xz');
  await extractDebPayload(debFile, out, supported);
  assert.deepEqual(await readFile(out), payload);

  // Tampering with the outer .deb or pinning the wrong payload digest must be rejected.
  const tampered = Buffer.from(debBytes);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(debFile, tampered);
  await assert.rejects(extractDebPayload(debFile, out, supported), /摘要不匹配/);

  await writeFile(debFile, debBytes);
  await assert.rejects(
    extractDebPayload(debFile, out, { ...supported, payload: { ...supported.payload, sha256: '0'.repeat(64) } }),
    /数据归档摘要不匹配/,
  );
  await writeFile(path.join(dir, 'bad.deb'), 'not-an-ar-archive');
  await assert.rejects(listArEntries(path.join(dir, 'bad.deb')), /ar/);
});

test('Linux window chrome uses the official frameless workspace and framed pairing window', () => {
  assert.deepEqual(windowChrome('#111111', 'linux'), { frame: false, titleBarStyle: 'default', autoHideMenuBar: true });
  assert.deepEqual(connectWindowChrome('linux'), { frame: true, autoHideMenuBar: true });

  const sent = [], events = new Map();
  let maximized = false, overlayCalls = 0, closed = 0, minimized = 0;
  const win = {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => maximized,
    minimize: () => { minimized++; },
    maximize: () => { maximized = true; },
    unmaximize: () => { maximized = false; },
    show: () => {},
    focus: () => {},
    close: () => { closed++; },
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    setBounds: () => {},
    setTitleBarOverlay: () => { overlayCalls++; },
    on: (name, fn) => events.set(name, fn),
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
  const chrome = windowHandlers(win, '#111111', { platform: 'linux' });
  assert.equal(typeof chrome.handlers.minimizeWindow, 'function');
  assert.equal(typeof chrome.handlers.toggleMaximizeWindow, 'function');
  assert.equal(typeof chrome.handlers.closeWindow, 'function');
  chrome.handlers.minimizeWindow();
  chrome.handlers.toggleMaximizeWindow();
  chrome.handlers.closeWindow();
  chrome.handlers.setTitleBarOverlayTone({ isOverlayTone: true });
  chrome.setBackground('#ffffff');
  events.get('maximize')();
  assert.equal(minimized, 1);
  assert.equal(maximized, true);
  assert.equal(closed, 1);
  assert.equal(overlayCalls, 0, 'Linux must never call Windows-only setTitleBarOverlay');
  assert.deepEqual(sent, [['dune-rpc:main:e:window-state', { isFullscreen: false, isMaximized: true }]]);

  let trayPath;
  createTray({
    Tray: class { constructor(img) { trayPath = img; } setToolTip() {} setContextMenu() {} on() {} },
    Menu: { buildFromTemplate: items => items },
    nativeImage: { createFromPath: file => file },
    clientRoot: '/opt/grokbot-local',
    show: () => {},
    quit: () => {},
    text: (_zh, en) => en,
    platform: 'linux',
  });
  assert.equal(path.basename(trayPath), 'icon.png');
});

test('Linux credential encryption enables basic_text fallback only when selected and reports Linux keyring hint', () => {
  setLocaleSource(() => 'en');
  assert.match(credentialUnavailableText('linux'), /GNOME Keyring|KWallet/);
  let plainEnabled = false;
  const basicTextStorage = {
    isEncryptionAvailable: () => plainEnabled,
    getSelectedStorageBackend: () => 'basic_text',
    setUsePlainTextEncryption: value => { plainEnabled = value; },
  };
  assert.equal(ensureCredentialEncryption(basicTextStorage, 'linux'), true);
  assert.equal(plainEnabled, true);

  let otherOptedIn = false;
  const unavailableStorage = {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'unknown',
    setUsePlainTextEncryption: () => { otherOptedIn = true; },
  };
  assert.equal(ensureCredentialEncryption(unavailableStorage, 'linux'), false);
  assert.equal(otherOptedIn, false);
});

test('Linux machine IDs use linux- prefix and sound playback falls back across PipeWire, PulseAudio and ALSA', () => {
  assert.equal(machineIdForPlatform('dev1', 'linux'), 'linux-dev1');
  assert.equal(machineIdForPlatform('dev1', 'win32'), 'win-dev1');
  assert.equal(machineIdForPlatform('dev1', 'darwin'), 'mac-dev1');

  const tried = [];
  const spawnImpl = (cmd, args) => {
    tried.push([cmd, args]);
    const child = new EventEmitter();
    child.kill = () => {};
    if (cmd !== 'aplay') {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    }
    return child;
  };
  spawnSoundPlayer('/tmp/ping.wav', { platform: 'linux', spawnImpl });
  return new Promise(resolve => setTimeout(() => {
    assert.deepEqual(tried, [
      ['pw-play', ['/tmp/ping.wav']],
      ['paplay', ['/tmp/ping.wav']],
      ['aplay', ['/tmp/ping.wav']],
    ]);
    resolve();
  }, 20));
});

test('Linux launcher, installer and desktop entry only claim grokbot-local:// and generate valid shell', () => {
  const entry = desktopEntry('/home/user/.local/share/grokbot-local/grokbot-local');
  assert.ok(entry.includes('MimeType=x-scheme-handler/grokbot-local;'));
  assert.ok(!entry.includes('x-scheme-handler/grokbot;'));
  assert.ok(desktopEntry('/home/user/my apps/grokbot-local').includes('Exec="/home/user/my apps/grokbot-local" %U'));
  assert.ok(apparmorProfile('/home/user/.local/share/grokbot-local/grok-bot').includes('userns,'));

  if (process.platform !== 'win32') {
    for (const [label, script] of [
      ['grokbot-local', launcherScript()],
      ['install.sh', installScript()],
      ['uninstall.sh', uninstallScript()],
      ['setup-apparmor.sh', setupAppArmorScript()],
    ]) {
      const check = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
      assert.equal(check.status, 0, `${label} failed sh -n: ${check.stderr}`);
    }
  }
});

test('install.sh and uninstall.sh replace or remove only a Grok Bot Local install', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grokbot-linux-install-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'grokbot-local');
  await mkdir(path.join(source, 'resources'), { recursive: true });
  for (const [name, body, mode] of [
    ['grok-bot', '#!/bin/sh\n', 0o755], ['grokbot-local', launcherScript(), 0o755],
    ['install.sh', installScript(), 0o755], ['uninstall.sh', uninstallScript(), 0o755],
    ['setup-apparmor.sh', setupAppArmorScript(), 0o755], ['resources/app.asar', '', 0o644],
    ['resources/grokbot-local.patch.json', '{}', 0o644], ['resources/grokbot-tailcat', '', 0o755],
  ]) await writeFile(path.join(source, name), body, { mode });
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_DATA_HOME: '' };
  const bin = path.join(root, 'bin');
  const run = (script, ...args) => spawnSync('sh', [path.join(source, script), ...args], { env, encoding: 'utf8' });

  const foreign = path.join(root, 'documents');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'keep.txt'), 'keep');
  let result = run('install.sh', '--dir', foreign, '--bin-dir', bin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Refusing to replace/);
  result = run('uninstall.sh', '--dir', foreign, '--bin-dir', bin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Refusing to remove/);
  assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');

  const target = path.join(root, 'my apps', 'grokbot-local');
  for (let pass = 0; pass < 2; pass += 1) {
    result = run('install.sh', '--dir', target, '--bin-dir', bin);
    assert.equal(result.status, 0, result.stderr);
  }
  const entry = await readFile(path.join(root, 'home', '.local', 'share', 'applications', 'grokbot-local.desktop'), 'utf8');
  assert.ok(entry.includes(`Exec="${target}/grokbot-local" %U`), entry);
  result = run('uninstall.sh', '--dir', target, '--bin-dir', bin);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('patch.mjs --help prints usage without downloading', () => {
  const patchScript = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [patchScript, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /--arch <x64\|arm64>/);
  assert.match(run.stdout, /--verify-only/);
});
