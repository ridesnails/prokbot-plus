import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const assets = {
  'ping-1-open-blip': 'tmp-1-open-blip-D1y74m9N.wav',
  'ping-2-tick': 'tmp-2-tick-DY1KrPne.wav',
  'ping-3-double-tick': 'tmp-3-double-tick-CdEXJqnB.wav',
  'ping-4-chime-a': 'tmp-4-chime-a-CH10PUxT.wav',
  'ping-5-chime-b': 'tmp-5-chime-b-B3aR0Am-.wav',
};
export const LINUX_SOUND_PLAYERS = ['pw-play', 'paplay', 'aplay'];

export function spawnSoundPlayer(file, { platform = process.platform, spawnImpl = spawn, players = LINUX_SOUND_PLAYERS, onChild = () => {} } = {}) {
  if (platform === 'win32') {
    // Windows has no command-line player; the system SoundPlayer reads the path from the environment.
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      '(New-Object System.Media.SoundPlayer $env:GROKBOT_SOUND_FILE).PlaySync()'],
      { stdio: 'ignore', windowsHide: true, env: { ...process.env, GROKBOT_SOUND_FILE: file } });
    onChild(child);
    return child;
  }
  if (platform === 'linux') {
    const startAt = index => {
      if (index >= players.length) return null;
      const child = spawnImpl(players[index], [file], { stdio: 'ignore' });
      onChild(child);
      child.once('error', error => {
        if (error?.code === 'ENOENT') startAt(index + 1);
      });
      return child;
    };
    return startAt(0);
  }
  const child = spawnImpl('/usr/bin/afplay', [file], { stdio: 'ignore' });
  onChild(child);
  return child;
}

export async function createSounds(profile, payload, { platform = process.platform, spawnImpl = spawn } = {}) {
  const directory = path.join(profile, 'notification-sounds');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const filename of Object.values(assets)) {
    await writeFile(path.join(directory, filename), await readFile(path.join(payload, 'renderer/assets', filename)), { mode: 0o600 });
  }
  const children = new Set();
  const track = child => {
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.once('error', () => children.delete(child));
  };
  return {
    play(sound) {
      if (!assets[sound]) return;
      const file = path.join(directory, assets[sound]);
      spawnSoundPlayer(file, { platform, spawnImpl, onChild: track });
    },
    stop() { for (const child of children) child.kill(); children.clear(); },
  };
}
