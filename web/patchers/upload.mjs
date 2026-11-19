// Installs a web client bundle on a Host through its admin API, as the admin page's upload does.
// The administrator password comes from GROKBOT_ADMIN_PASSWORD, a file or the terminal; it is
// never taken from the command line, where other users could read it.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export async function adminPassword(file) {
  if (file) return (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
  if (process.env.GROKBOT_ADMIN_PASSWORD) return process.env.GROKBOT_ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('上传需要管理员密码：设置 GROKBOT_ADMIN_PASSWORD，或用 --password-file 指定文件。');
  return new Promise((resolve, reject) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let masked = false;
    const write = terminal._writeToOutput?.bind(terminal);
    terminal._writeToOutput = text => { if (!masked) write?.(text); };
    terminal.question('Host 管理员密码：', value => { terminal.close(); process.stderr.write('\n'); resolve(value); });
    masked = true;
    terminal.on('SIGINT', () => { terminal.close(); reject(new Error('已取消')); });
  });
}

export function hostOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Host 地址无效：${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Host 地址需要 http:// 或 https://，且不能包含用户名和密码。');
  return url.origin;
}

async function call(origin, path, { method = 'GET', cookie, body, type = 'application/json' } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(10 * 60_000),
    headers: { 'x-grokbot-csrf': '1', ...(body !== undefined ? { 'content-type': type } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body } : {}),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${value?.error ?? `HTTP ${response.status}`}（${method} ${path}）`);
  return { value, response };
}

/** Signs in, uploads the bundle, enables the web client and signs out again. */
export async function uploadBundle(address, zip, password) {
  const origin = hostOrigin(address);
  const { response } = await call(origin, '/admin/api/login', { method: 'POST', body: JSON.stringify({ password }) });
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  try {
    const { value } = await call(origin, '/admin/api/web-client', { method: 'PUT', cookie, body: zip, type: 'application/zip' });
    if (!value.enabled) return (await call(origin, '/admin/api/web-client', { method: 'PATCH', cookie, body: JSON.stringify({ enabled: true }) })).value;
    return value;
  } finally {
    await call(origin, '/admin/api/logout', { method: 'POST', cookie, body: '{}' }).catch(() => {});
  }
}
