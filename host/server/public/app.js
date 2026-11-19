import { t, localize } from './i18n.js';
import { $, all, busy, copyText } from './ui.js';
import { icon } from './icons.js';
import { renderNavigation, titles } from './navigation.js';
import { setupPrivacy } from './privacy.js';
import { createLoginStage } from './login.js';
import { createOverview } from './overview.js';
import { createGeneral } from './general.js';
import { createModelPage } from './model.js';
import { createSpeechPage } from './speech.js';
import { createMediaEditor } from './media.js';
import { createWebServicesEditor } from './media-web.js';
import { createHarnessEditor } from './harness.js';
import { createSkillsEditor } from './skills.js';
import { createApps } from './apps.js';
import { createPromptEditor } from './prompts.js';
import { createDevices } from './devices.js';
import { createWebClientPage } from './web-client.js';
import { createNetworkEditor } from './network.js';
import { createExecutionEditor } from './execution.js';
import { createFederationEditor } from './federation.js';
import { createWebhookEditor } from './webhooks.js';
import { createSharingEditor } from './sharing.js';

const aliases = { profile: 'general', notifications: 'devices', plugins: 'apps', connectors: 'apps' };
const sessionPaths = new Set(['/admin/api/session', '/admin/api/login', '/admin/api/setup']);
const expiredSession = () => new Error(t('会话已过期，请重新登录。'));
let initialized = false, state = null, activeView = 'overview', poll = null, toastTimer;
let consoleSession = null, statusPending = null;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 5000);
}

async function api(path, { method = 'GET', body, signal = consoleSession?.signal, binary = false } = {}) {
  const session = consoleSession;
  const publicPath = sessionPaths.has(path);
  if (!publicPath && !session) throw expiredSession();
  if (body === undefined && !['GET', 'HEAD'].includes(method)) body = {};
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json', 'x-grokbot-csrf': '1' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(t('无法连接管理服务。'));
  }
  if (response.status === 401 && !publicPath) {
    const error = expiredSession();
    if (session === consoleSession) showAuth(error.message);
    throw error;
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(typeof value?.error === 'string' && value.error.trim() ? t(value.error) : t('请求失败 ({0})', response.status));
  }
  if (binary) return response.blob();
  if (response.status === 204) return {};
  try { return await response.json(); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(t('管理服务返回了无效响应 (HTTP {0})。', response.status));
  }
}

const act = (control, work) => busy(control, async () => {
  try { return await work(); } catch (error) { toast(error.message, true); }
});
async function copy(value) {
  try { await copyText(value); toast(t('已复制')); }
  catch { toast(t('浏览器未允许复制，请选择文字后复制'), true); }
}

const context = { api, toast, busy, act, copy, refresh: () => refresh(), navigate: view => showView(view), status: () => state };
renderNavigation($('#nav'));
const views = {
  overview: createOverview(context), general: createGeneral(context), model: createModelPage(context),
  speech: createSpeechPage(context), media: createMediaEditor(context), 'web-services': createWebServicesEditor(context),
  harness: createHarnessEditor(context), skills: createSkillsEditor(context), apps: createApps(context), prompts: createPromptEditor(context), devices: createDevices(context),
  'web-client': createWebClientPage(context),
  network: createNetworkEditor(context), execution: createExecutionEditor(context), federation: createFederationEditor(context),
  webhooks: createWebhookEditor(context), sharing: createSharingEditor(context),
};
setupPrivacy();
const loginStage = createLoginStage();
localize(document.body);
$('#nav-toggle').innerHTML = icon('menu');

function showAuth(message = '') {
  consoleSession?.abort(); consoleSession = null;
  statusPending?.abort(); statusPending = null;
  clearInterval(poll); poll = null; state = null;
  $('#console').hidden = true; $('#loading').hidden = true; $('#auth-screen').hidden = false;
  $('#auth-title').textContent = initialized ? t('登录 Host') : t('设置 Host');
  $('#setup-key-label').hidden = initialized;
  $('#setup-key').required = !initialized;
  $('#setup-key').placeholder = t('初始化密钥，见数据目录中的 setup-key 文件');
  $('#auth-password').autocomplete = initialized ? 'current-password' : 'new-password';
  $('#auth-password').placeholder = initialized ? t('管理员密码') : t('新的管理员密码，至少 12 个字符');
  $('#auth-submit').setAttribute('aria-label', initialized ? t('登录') : t('创建管理员'));
  $('#auth-password').value = '';
  for (const view of Object.values(views)) view.reset?.();
  for (const dialog of all('dialog[open]')) dialog.close();
  loginStage.show(message);
  if (message) $('#auth-password').focus();
}

async function showConsole() {
  const session = consoleSession = new AbortController();
  loginStage.hide();
  $('#auth-screen').hidden = true; $('#loading').hidden = true; $('#console').hidden = false;
  $('#auth-form').reset();
  const checking = t('正在检查');
  setHealth(checking, ''); views.overview.statusUnavailable(checking);
  await refresh(true);
  if (session !== consoleSession) return;
  showView(activeView);
  clearInterval(poll);
  poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

function showView(view) {
  activeView = views[aliases[view] ?? view] ? aliases[view] ?? view : 'overview';
  for (const panel of all('[data-panel]')) panel.hidden = panel.dataset.panel !== activeView;
  for (const element of all('.nav-item')) {
    const active = element.dataset.view === activeView;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  }
  document.title = `${titles[activeView]} · Grok Bot Host`;
  $('#sidebar').classList.remove('open'); $('#nav-toggle').setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  const params = new URLSearchParams(location.search); params.set('view', activeView);
  history.replaceState(null, '', `${location.pathname}?${params}`);
  views[activeView].load?.().catch(error => toast(error.message, true));
}

function hostTitle() {
  if (state.host.connected) return state.host.busy ? [t('任务运行中'), 'accent'] : [t('Host 就绪'), 'success'];
  if (state.model.configured && state.host.waitingForExecutionNode) return [t('需要执行节点'), 'warn'];
  return state.model.configured ? [t('等待 Host'), 'warn'] : [t('等待配置'), 'warn'];
}

function setHealth(title, tone) {
  $('#header-health').textContent = title;
  $('#header-health').dataset.tone = tone;
}

function statusUnavailable(detail) {
  state = null;
  const title = t('状态不可用');
  setHealth(title, 'warn'); views.overview.statusUnavailable(title, detail);
}

async function refresh(showError = false) {
  if (!consoleSession || statusPending) return;
  // Only the current probe may update health, even if an old one finishes after re-login.
  const request = statusPending = new AbortController();
  const timeout = setTimeout(() => request.abort(new Error(t('读取 Host 状态超时。'))), 12_000);
  try {
    const next = await api('/admin/api/status', { signal: request.signal });
    if (request !== statusPending) return;
    state = next;
    setHealth(...hostTitle());
    for (const view of Object.values(views)) view.status?.(state, view === views[activeView]);
  } catch (error) {
    if (request !== statusPending) return;
    statusUnavailable(error.message);
    if (showError) toast(error.message, true);
  } finally {
    clearTimeout(timeout);
    if (statusPending === request) statusPending = null;
  }
}

addEventListener('offline', () => {
  if (!consoleSession) return;
  statusPending?.abort(); statusPending = null;
  statusUnavailable(t('无法连接管理服务。'));
});
addEventListener('online', () => { if (!document.hidden) refresh(); });

$('#auth-form').addEventListener('submit', event => {
  event.preventDefault();
  busy($('#auth-submit'), async () => {
    loginStage.thinking();
    try {
      await api(`/admin/api/${initialized ? 'login' : 'setup'}`, { method: 'POST',
        body: { setupKey: $('#setup-key').value, password: $('#auth-password').value } });
      initialized = true;
      await loginStage.success();
      await showConsole();
    } catch (error) {
      loginStage.error(error.message);
    }
  });
});
document.addEventListener('click', event => {
  const target = event.target.closest('[data-view]');
  if (!target || !$('#console').contains(target)) return;
  event.preventDefault();
  showView(target.dataset.view);
});
$('#nav-toggle').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#nav-toggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('grokbot:logout', () => showAuth());

try {
  const session = await api('/admin/api/session');
  initialized = session.initialized;
  const params = new URLSearchParams(location.search);
  const requested = params.get('view');
  if (requested) activeView = views[aliases[requested] ?? requested] ? aliases[requested] ?? requested : 'overview';
  if (params.has('authorization')) {
    const success = params.get('authorization') === 'success';
    toast(success ? t('应用授权已完成') : t('应用授权未完成，请在应用详情查看状态'), !success);
    params.delete('authorization');
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  if (session.authenticated) await showConsole(); else showAuth();
} catch (error) {
  $('#loading').textContent = t('连接失败：{0}。刷新页面重试。', error.message);
}
