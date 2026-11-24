import path from 'node:path';

/**
 * Explains an explicit installer that matched no pinned release. Known official installers were
 * already recognised by size and SHA-256 before verification, so this one is unknown or altered.
 */
export async function withInstallerDiagnostic(verification, explicitSource, supported, accepted = [supported.version]) {
  try { return await verification; }
  catch (cause) {
    // The shared Windows/Android wrapper verifier reports this exact, untyped pin error.
    if (cause?.message !== '官方安装包摘要不匹配。' || !explicitSource || path.extname(explicitSource).toLowerCase() !== '.exe') throw cause;
    const [recommended, ...older] = accepted;
    const zhList = older.length ? `${recommended}（推荐）或 ${older.join('、')}` : `${recommended}（推荐）`;
    const enList = older.length ? `${recommended} (recommended) or ${older.join(', ')}` : `${recommended} (recommended)`;
    const target = `Grok Bot ${supported.version} Windows ${supported.architecture}`;
    throw new Error('安装包摘要不匹配，无法确认此文件的版本或来源。未进入配对。\n' +
      `补丁接受未经修改的官方 Grok Bot ${zhList} Windows ${supported.architecture} 安装包。省略 --source 重新运行即可下载并校验 ${target} 安装包，无需卸载现有客户端。\n` +
      'Installer fingerprint mismatch. The version and origin of this file are unverified. Pairing did not run.\n' +
      `The patch accepts the unmodified official Grok Bot ${enList} Windows ${supported.architecture} installer. ` +
      `Omit --source to fetch the exact supported ${target} installer. No need to uninstall your existing app.`, { cause });
  }
}
