import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { grokText } from './i18n.mjs';

export function createClientPersistence(profile) {
  const file = path.join(profile, 'local-client-persistence.json');
  let state, queue = Promise.resolve();
  async function load() {
    if (state) return state;
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw new Error(grokText(
        '无法读取桌面设置文件 local-client-persistence.json；已保留原文件。',
        'Cannot read the desktop profile local-client-persistence.json. The original file was preserved.'), { cause });
      return state = Object.create(null);
    }
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    if (data && typeof data === 'object' && !Array.isArray(data)) return state = Object.assign(Object.create(null), data);
    // Earlier clients did not write this file atomically, so an upgrade can find it damaged. Keep it
    // under another name and start empty; the account and sidebar state are restored from the Host.
    const kept = `${file}.damaged-${Date.now()}`;
    try { await rename(file, kept); }
    catch (cause) {
      throw new Error(grokText(
        '桌面设置文件 local-client-persistence.json 已损坏，且无法改名备份；已保留原文件。',
        'The desktop profile local-client-persistence.json is damaged and could not be renamed. The original file was preserved.'), { cause });
    }
    console.warn(`[persistence] ${path.basename(file)} was damaged; kept as ${path.basename(kept)}`);
    return state = Object.create(null);
  }
  function ordered(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  function update(edit) {
    return ordered(async () => {
      const next = Object.assign(Object.create(null), await load());
      edit(next);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(JSON.stringify(next), 'utf8'); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }); throw error;
      }
      state = next; // A rejected disk write must not become visible or leak into the next save.
    });
  }
  const read = select => ordered(async () => select(await load()));
  return {
    readClientPersistence: ({ key }) => read(data => data[key] ?? null),
    readManyClientPersistence: ({ include, exclude = [] }) => read(data =>
      Object.fromEntries(Object.entries(data).filter(([key]) => {
        const longest = prefixes => prefixes.reduce((len, prefix) =>
          key.startsWith(prefix) ? Math.max(len, prefix.length) : len, -1);
        const length = longest(include);
        return length >= 0 && length >= longest(exclude);
      }))),
    writeClientPersistence: ({ key, value }) => update(data => { data[key] = value; }),
    removeClientPersistence: ({ key }) => update(data => { delete data[key]; }),
    listClientPersistenceKeys: ({ prefix }) => read(data => Object.keys(data).filter(key => key.startsWith(prefix))),
    hasMigratedClientPersistence: () => true,
    migrateClientPersistence: ({ entries }) => update(data => { for (const { key, value } of entries) data[key] = value; }),
  };
}
