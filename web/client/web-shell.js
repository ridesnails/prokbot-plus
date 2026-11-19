// Browser behaviour the Android shell provides natively, for the web client. Loaded after
// bridge.js, which defines window.__grokbotAndroid:
//
// - the browser's back button and gesture close dialogs and return from a conversation to the
//   Bot list on a phone, as the Android back key does, before they leave the page;
// - visibility and the system colour scheme reach the bridge as the shell's focus and theme events;
// - the page follows the visible area, so the on-screen keyboard does not cover the message field;
// - while the page is open, Host notifications appear as browser notifications for Bots that are
//   not on screen. Closed pages get nothing; Bark or the phone apps cover that.
import { subscribe } from './gateway.js';
import { webState } from './native.js';

const shell = window.__grokbotAndroid;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

// ---- back -------------------------------------------------------------------------------------

const GUARD = { grokbotWeb: 'guard' };
if (history.state?.grokbotWeb !== 'guard') history.pushState(GUARD, '');
addEventListener('popstate', () => {
  if (shell.back() === 'handled') history.pushState(GUARD, '');
  else history.back();
});

// ---- focus and theme --------------------------------------------------------------------------

const reportFocus = () => shell.event({ type: 'focus', payload: { focused: document.visibilityState === 'visible' } });
document.addEventListener('visibilitychange', reportFocus);
const scheme = matchMedia('(prefers-color-scheme: dark)');
scheme.addEventListener('change', () => shell.event({ type: 'system-theme', payload: { dark: scheme.matches } }));

// ---- visible area -----------------------------------------------------------------------------

const viewport = window.visualViewport;
if (viewport) {
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    root.style.setProperty('--grokbot-viewport-height', `${Math.round(viewport.height)}px`);
    // iOS scrolls the whole page to reveal a focused field; the page itself never scrolls.
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  apply();
}

// ---- notifications ----------------------------------------------------------------------------

// Kept for the tab's session, so reloading the page does not repeat the last few notifications.
const SHOWN = 'grokbot-web:notified';
const shown = new Set((() => { try { return JSON.parse(sessionStorage.getItem(SHOWN) ?? '[]'); } catch { return []; } })());
const startedAt = Date.now();
function notify(item) {
  if (typeof Notification !== 'function' || Notification.permission !== 'granted') return;
  const agentId = item?.agentId;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return;
  const id = String(item.id ?? `${agentId}:${item.createdAt}`);
  // The stream starts with recent history; only what arrives after the page opened is new.
  if (shown.has(id) || !(Date.parse(item.createdAt) >= startedAt - 5000)) return;
  shown.add(id);
  try { sessionStorage.setItem(SHOWN, JSON.stringify([...shown].slice(-50))); } catch {}
  if (document.visibilityState === 'visible' && webState.viewingAgent === agentId) return;
  try {
    const notification = new Notification(String(item.title || 'Grok Bot').slice(0, 200), {
      body: String(item.body ?? '').slice(0, 1000), tag: `grokbot-${agentId}`,
    });
    notification.onclick = () => {
      window.focus();
      shell.event({ type: 'focus-agent', payload: { id: agentId } });
      notification.close();
    };
  } catch {
    // Android Chrome only shows notifications through a service worker; the page keeps working.
  }
}
let notifications;
function listen() {
  notifications = new AbortController();
  void subscribe('/notifications/events', ({ data }) => {
    for (const item of Array.isArray(data?.items) ? data.items : [data]) notify(item);
  }, notifications.signal, { requireEventStream: true });
}
addEventListener('pagehide', () => notifications.abort());
// A page restored from the back-forward cache needs its stream again.
addEventListener('pageshow', event => { if (event.persisted) listen(); });
listen();

reportFocus();
