// The web client's stand-in for android/client/native.js. In the Android app these calls go
// to the shell; here the page is served by the Host itself, so each one is a browser feature
// or a call to the Host's /web/api. The exports match the Android module, which the bridge,
// gateway and services import unchanged.
export const boot = globalThis.__grokbotAndroidBoot ?? {};

const SETTINGS = 'grokbot-web:settings', PERSISTENCE = 'grokbot-web:persistence';
const SETTING_KEYS = new Set(['theme', 'language', 'realtimeVoice', 'botColor', 'spellCheck', 'timeZone', 'backgroundNotifications']);
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const chinese = () => /^zh/i.test(document.documentElement.lang || boot.locale || navigator.language || '');
const text = (zh, en) => chinese() ? zh : en;

function readStore(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  // Private browsing or a full quota: keep the state for this page only.
  catch (error) { console.warn('[grokbot-web] could not save', key, error?.name ?? error); return false; }
}

const settings = { ...(boot.settings ?? {}) };
const persistence = { ...(boot.persistence ?? {}) };
const saves = new Map();
let pendingAgent = boot.pendingAgent ?? null;

/** Shared with web-shell.js: the Bot on screen, so its replies do not raise notifications. */
export const webState = { viewingAgent: '' };

async function hostCall(path, body, method = 'POST') {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-grokbot-web': '1' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`);
  return value;
}

function setThemeColor(background) {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = background;
}

function deviceName() {
  const agent = navigator.userAgent;
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : '';
  return [system, browser].filter(Boolean).join(' · ') || text('浏览器', 'Browser');
}

function download(name, mime, chunks) {
  const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Safari starts reading the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const calls = {
  status: () => hostCall('/web/api/session', null, 'GET'),
  async pair({ server, key, edit }) {
    let target = location.origin;
    try { if (server) target = new URL(server).origin; } catch {}
    if (target !== location.origin)
      return { ok: false, error: text('网页版只连接提供这个网页的 Host。要换 Host，请打开那台 Host 的网页版。',
        'The web client connects only to the Host that serves this page. To use another Host, open its web client.') };
    if (edit || !key) return { ok: true };
    await hostCall('/web/api/pair', { pairingKey: key, deviceName: deviceName() });
    location.assign('/web/');
    return { ok: true };
  },
  async disconnect() {
    await hostCall('/web/api/logout', {}).catch(() => {});
    location.assign('/web/login');
    return { ok: true };
  },
  unauthorized() {
    location.assign('/web/login?expired=1');
    return { ok: true };
  },
  settings({ key, value }) {
    if (!SETTING_KEYS.has(key)) throw new Error('Invalid setting');
    settings[key] = value;
    writeStore(SETTINGS, settings);
    return { ok: true, settings: { ...settings } };
  },
  persistence({ ops }) {
    if (!Array.isArray(ops)) throw new Error('Invalid persistence update');
    for (const { op, key, value } of ops) {
      if (typeof key !== 'string') continue;
      if (op === 'remove') delete persistence[key]; else persistence[key] = value;
    }
    writeStore(PERSISTENCE, persistence);
    return { ok: true };
  },
  theme({ dark, background }) {
    if (/^#[0-9a-fA-F]{6}$/.test(background ?? '')) setThemeColor(background);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    return { ok: true, systemDark: matchMedia('(prefers-color-scheme: dark)').matches };
  },
  'open-external'({ url }) {
    const target = new URL(url, location.href);
    if (!['http:', 'https:', 'mailto:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid link');
    if (target.protocol === 'mailto:') location.href = target.href;
    else window.open(target.href, '_blank', 'noopener,noreferrer');
    return { ok: true };
  },
  'viewing-agent'({ agentId }) {
    webState.viewingAgent = AGENT_ID.test(agentId ?? '') ? agentId : '';
    return { ok: true };
  },
  ready() {
    const value = pendingAgent;
    pendingAgent = null;
    return { ok: true, pendingAgent: value };
  },
  reload() {
    location.reload();
    return { ok: true };
  },
  async 'notification-permission'() {
    if (typeof Notification !== 'function') return { ok: true, granted: false };
    return { ok: true, granted: (await Notification.requestPermission()) === 'granted' };
  },
  'save-begin'({ name, mime }) {
    const id = crypto.randomUUID();
    saves.set(id, { name: String(name || 'download').replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 200),
      mime: /^[\w.+-]+\/[\w.+-]+$/.test(mime ?? '') ? mime : 'application/octet-stream', chunks: [] });
    return { ok: true, id };
  },
  'save-end'({ id, ok }) {
    const pending = saves.get(id);
    if (!pending) throw new Error('Unknown download');
    saves.delete(id);
    if (ok) download(pending.name, pending.mime, pending.chunks);
    return { ok: true };
  },
  log({ message }) {
    console.info('[grokbot-web]', String(message).slice(0, 4000));
    return { ok: true };
  },
};

export async function native(name, body = {}, { binary } = {}) {
  const chunk = /^save-chunk\?id=(.+)$/.exec(name);
  if (chunk) {
    const pending = saves.get(decodeURIComponent(chunk[1]));
    if (!pending) throw new Error('Unknown download');
    pending.chunks.push(toBytes(binary).slice());
    return { ok: true };
  }
  const call = Object.hasOwn(calls, name) ? calls[name] : null;
  if (!call) throw new Error('Unknown native call');
  const value = await call(body ?? {});
  if (value?.ok === false) throw new Error(value.error);
  return value;
}

export function log(...parts) {
  const message = parts.map(part => part instanceof Error ? `${part.name}: ${part.message}` :
    typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
  console.info('[grokbot-web]', message.slice(0, 4000));
}

export function toBase64(input) {
  const bytes = toBytes(input);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError('Expected bytes');
}

export function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 1) return { signal: list[0], dispose() {} };
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(list), dispose() {} };
  const aborted = list.find(signal => signal.aborted);
  if (aborted) return { signal: aborted, dispose() {} };
  const controller = new AbortController();
  const dispose = () => { for (const signal of list) signal.removeEventListener('abort', abort); };
  const abort = event => { dispose(); controller.abort(event.target.reason); };
  for (const signal of list) signal.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose };
}

export function timeout(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  return controller.signal;
}
