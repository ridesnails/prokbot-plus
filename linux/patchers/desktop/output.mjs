import { link, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function physicalPath(name) {
  name = path.resolve(name);
  try { return await realpath(name); } catch (error) {
    const parent = path.dirname(name);
    if (error.code !== 'ENOENT' || parent === name) throw error;
    return path.join(await physicalPath(parent), path.basename(name));
  }
}

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

export async function checkOutputLocation(source, root, targets) {
  const original = await realpath(source);
  if (inside(original, await physicalPath(root))) throw new Error(`Output would modify the source: ${root}`);
  for (const target of targets) {
    const name = await physicalPath(target);
    if (inside(original, name) || inside(name, original)) throw new Error(`Output overlaps the source: ${target}`);
    try { await lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`输出已存在，不会覆盖：${target}`);
  }
}

export async function writeNewFile(destination, write) {
  const file = await open(destination, 'wx');
  try {
    try { await write(file); } finally { await file.close(); }
  } catch (error) {
    await rm(destination);
    throw error;
  }
}

async function publishFile(source, destination) {
  try { await link(source, destination); } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error;
    await writeNewFile(destination, async file => {
      for await (const chunk of createReadStream(source)) await file.writeFile(chunk);
    });
  }
}

const digest = async name => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(name)) hash.update(chunk);
  return hash.digest('hex');
};

export async function publishBuild(stagedApp, appOutput, files) {
  const published = [];
  try {
    for (const { source, destination, sha256 } of files) {
      await publishFile(source, destination);
      const info = await lstat(destination, { bigint: true });
      published.push({ destination, sha256, info });
    }
    await rename(stagedApp, appOutput);
  } catch (error) {
    const failures = [];
    for (const { destination, sha256, info } of published.reverse()) {
      try {
        const current = await lstat(destination, { bigint: true });
        if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino ||
            await digest(destination) !== sha256)
          throw new Error(`Leaving changed output in place: ${destination}`);
        await rm(destination);
      } catch (failure) { if (failure.code !== 'ENOENT') failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], [error, ...failures].map(e => e.message).join('\n'));
    throw error;
  }
}
