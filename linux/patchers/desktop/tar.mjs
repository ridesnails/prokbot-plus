// Create a portable .tar.gz archive preserving POSIX file permissions without
// macOS AppleDouble metadata or overriding an existing destination file.
import { execFileSync } from 'node:child_process';
import { stat, rm } from 'node:fs/promises';
import path from 'node:path';

export async function writeTarGz(sourceDir, destination) {
  try {
    await stat(destination);
    const error = new Error(`Destination already exists: ${destination}`);
    error.code = 'EEXIST';
    throw error;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(sourceDir);
  const name = path.basename(sourceDir);
  const env = { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' };
  const extraFlags = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
  try {
    execFileSync('tar', [...extraFlags, '-czf', destination, '-C', parent, name], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`创建便携压缩包失败：${detail}`);
  }
  const info = await stat(destination);
  return { bytes: info.size };
}
