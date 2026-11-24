// Verified reading and unpacking of official Linux .deb packages (or an
// extracted Grok Bot Linux app directory). Uses pure-JS ar parsing so .deb
// verification and extraction work identically on Linux and macOS without dpkg.
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const AR_MAGIC = '!<arch>\n';

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/** Parse a standard UNIX ar archive (.deb) and return member offset/size metadata. */
export async function listArEntries(filename) {
  const info = await stat(filename);
  if (!info.isFile() || info.size < AR_MAGIC.length) throw new Error('无效的 .deb 安装包。');
  const handle = await open(filename, 'r');
  try {
    const magic = Buffer.alloc(AR_MAGIC.length);
    await handle.read(magic, 0, magic.length, 0);
    if (magic.toString('ascii') !== AR_MAGIC) throw new Error('输入不是有效的 .deb（ar）归档文件。');
    const entries = new Map();
    const header = Buffer.alloc(60);
    let offset = AR_MAGIC.length;
    while (offset + 60 <= info.size) {
      const { bytesRead } = await handle.read(header, 0, 60, offset);
      if (bytesRead !== 60) throw new Error('无效的 .deb 归档头。');
      if (header[58] !== 0x60 || header[59] !== 0x0a) throw new Error('损坏的 .deb 成员头。');
      const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
      const sizeText = header.subarray(48, 58).toString('ascii').trim();
      if (!/^\d+$/.test(sizeText)) throw new Error(`无效的 .deb 成员大小：${name}`);
      const size = Number.parseInt(sizeText, 10);
      offset += 60;
      if (!Number.isSafeInteger(size) || offset + size > info.size) throw new Error(`.deb 成员越界：${name}`);
      entries.set(name, { offset, size });
      offset += size + (size % 2);
    }
    if (offset !== info.size) throw new Error('.deb 归档末尾存在未解析字节。');
    return entries;
  } finally {
    await handle.close();
  }
}

/** Verify the pinned .deb archive and extract its pinned data.tar.* payload to disk. */
export async function extractDebPayload(debFile, destination, supported) {
  const info = await stat(debFile);
  if (info.size !== supported.archive.bytes || await hashFile(debFile) !== supported.archive.sha256) {
    throw new Error(`原版 .deb 整包摘要不匹配；仅支持未经修改的 Grok Bot ${supported.version} Linux ${supported.architecture}。`);
  }
  const entries = await listArEntries(debFile);
  const member = entries.get(supported.payload.name);
  if (!member || member.size !== supported.payload.bytes) {
    throw new Error(`原版 .deb 中缺少或大小不匹配的数据归档：${supported.payload.name}`);
  }
  const handle = await open(debFile, 'r');
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(member.size);
    let copied = 0;
    while (copied < member.size) {
      const { bytesRead } = await handle.read(buffer, copied, member.size - copied, member.offset + copied);
      if (bytesRead <= 0) throw new Error('读取 .deb 数据归档失败。');
      copied += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const payloadSha = createHash('sha256').update(buffer).digest('hex');
  if (payloadSha !== supported.payload.sha256) {
    throw new Error(`原版 .deb 数据归档摘要不匹配：${supported.payload.name}`);
  }
  await writeFile(destination, buffer, { mode: 0o600 });
  return destination;
}

/**
 * Unpack an official Linux .deb into a temporary workspace and return the extracted
 * Grok Bot application directory (`opt/Grok Bot`), or return an existing directory directly.
 */
export async function unpackOriginal(source, temporary, supported) {
  const info = await stat(source);
  if (info.isDirectory()) return source;
  const work = await mkdtemp(path.join(temporary, 'original-'));
  try {
    const archive = path.join(work, supported.payload.name);
    await extractDebPayload(source, archive, supported);
    const root = path.join(work, 'root');
    await mkdir(root, { recursive: true });
    try {
      // Git for Windows puts GNU tar first, which reads a drive path as a remote host; the system tar handles drive paths and xz.
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      execFileSync(tar, ['-xf', archive, '-C', root], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      const detail = error.stderr ? String(error.stderr).trim() : error.message;
      throw new Error(`无法解压 ${supported.payload.name}，请确认已安装支持 xz 的 tar（xz-utils）：${detail}`);
    }
    const appDir = path.join(root, 'opt', 'Grok Bot');
    try {
      if (!(await stat(path.join(appDir, 'resources', 'app.asar'))).isFile()) throw new Error('missing asar');
    } catch {
      throw new Error('解压后的 .deb 中未找到 opt/Grok Bot/resources/app.asar。');
    }
    return appDir;
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}
