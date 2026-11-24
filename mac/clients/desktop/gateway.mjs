import { grokText } from './i18n.mjs';
import { subscribe } from './streams.mjs';

const COORDINATOR_VERSION = 3;

export function createGateway(config, onUnauthorized, onConnected, onStateChanged) {
  const lifetime = new AbortController();
  const streams = new Set();
  let state = 'connecting';
  const updateState = value => { if (state !== value) { state = value; onStateChanged?.(value); } };
  const close = () => { lifetime.abort(); updateState('disconnected'); };
  const revoked = () => { if (!lifetime.signal.aborted) { close(); onUnauthorized?.(); } };
  // Connectors and other Host features also answer 401 (an expired OAuth grant, for example), so a
  // failed request ends the session only when the Host rejects the device itself. A Host without
  // /connect/status gets the original prompt to pair again, without closing the gateway.
  let checking;
  const deviceStatus = () => checking ??= fetch(`${config.server}/connect/status`, {
    headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error',
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
  }).then(response => { void response.body?.cancel().catch(() => {}); return response.status; }, () => 0)
    .finally(() => { checking = undefined; });
  async function unauthorized() {
    if (lifetime.signal.aborted) return;
    const status = await deviceStatus();
    if (lifetime.signal.aborted) return;
    if (status === 401) revoked();
    else if (status === 404) onUnauthorized?.();
  }
  async function request(endpoint, args, signal, method = 'POST') {
    if (lifetime.signal.aborted) throw new Error(grokText('已退出连接，请重新连接。', 'Disconnected. Connect again.'));
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const response = await fetch(`${config.server}${endpoint}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      ...(method === 'GET' ? {} : { body: JSON.stringify(args) }),
      signal: active, redirect: 'error',
    });
    active.throwIfAborted(); // A late 401 for a closed port is not a revocation of its live siblings.
    if (process.env.GROKBOT_LOCAL_DEBUG_PORT) console.log('[gateway]', endpoint, response.status);
    if (!response.ok) {
      if (response.status === 401) await unauthorized();
      const value = await response.json().catch(() => null);
      throw Object.assign(new Error(value?.message ?? value?.error ?? `HTTP ${response.status}`),
        { httpStatus: response.status, failureCode: value?.failureCode });
    }
    return response.status === 204 || response.status === 205 ? null : await response.json();
  }
  async function command(method, args = {}, signal) {
    if (lifetime.signal.aborted) throw new Error(grokText('已退出连接，请重新连接。', 'Disconnected. Connect again.'));
    if (method === 'getServerAgentRoster') return { status: 'disabled' };
    if (method === 'getMainAgent') return { agentId: null };
    if (method === 'ensureDefaultMainAgent') {
      // The Host keeps no main Bot; the first visible Bot satisfies the client's non-empty ID check.
      const agents = await request('/api/listAgents', {}, signal);
      const first = Array.isArray(agents) ? agents.find(agent => typeof agent?.id === 'string' && !agent.isHiddenFromSidebar) : null;
      return { outcome: 'present', agentId: first?.id ?? null };
    }
    if (method === 'setMainAgent') return { agentId: typeof args?.agentId === 'string' ? args.agentId : null };
    if (method === 'dismissAgentSuggestions' || method === 'confirmTeachLearningPrompt') return null;
    if (method === 'resolveAgentCreation') return { kind: 'box' };
    if (method === 'restoreTemporalAgentRouting' || method === 'noteMountedAgent') return null;
    if (method === 'createAgent') { const { creationRoute, ...rest } = args; args = rest; }
    // Desktop 1.1.0 renamed global search and pages older results; the Host answers in one page.
    if (method === 'searchMessages' || method === 'searchFiles') {
      const matches = await request(`/api/${method === 'searchMessages' ? 'searchAgents' : 'searchMedia'}`, { query: args.query }, signal);
      return { matches, coverage: { kind: 'complete' } };
    }
    // The Host keeps no read receipts for transcripts and has no pending lessons to offer.
    if (method === 'noteTranscriptOpened') return null;
    if (method === 'takeTeachLearningPrompts') return [];
    return request(`/api/${encodeURIComponent(method)}`, args, signal);
  }
  function attach(port) {
    const controller = new AbortController();
    if (lifetime.signal.aborted) { port.close(); return () => {}; }
    let subscribed = false, generation = 0;
    const pending = new Map();
    const send = frame => { if (!controller.signal.aborted) port.postMessage(frame); };
    const emit = (family, payload) => send({ kind: 'event', family, payload });
    const receive = async ({ data: frame }) => {
      if (!frame || controller.signal.aborted) return;
      if (frame.kind === 'lifecycle' && frame.phase === 'hello') {
        // The legacy hello can omit a version. Never acknowledge a different explicit wire version.
        if (Object.hasOwn(frame, 'protocolVersion') && frame.protocolVersion !== COORDINATOR_VERSION) { dispose(); return; }
        // A second ready is a protocol error for a live renderer session.
        if (subscribed) return;
        subscribed = true;
        send({ kind: 'lifecycle', phase: 'ready', protocolVersion: COORDINATOR_VERSION });
        void subscribe(config, '/events', ({ data }) => {
          if (data.channel) emit(data.channel, data.payload);
        }, controller.signal, {
          onConnected: () => {
            streams.add(controller); updateState('online');
            emit('coordinator-transport-state', { state: 'connected' });
            emit('transport-connected', { generation: ++generation }); onConnected?.();
          },
          onDisconnected: () => {
            streams.delete(controller); if (!streams.size) updateState('reconnecting');
            emit('coordinator-transport-state', { state: 'down' });
            emit('transport-down', { generation, reason: 'stream-error', cause: null });
          },
          // The event stream answers 401 only for the device credential.
          onUnauthorized: revoked,
        });
      } else if (frame.kind === 'lifecycle' && frame.phase === 'shutdown') {
        dispose();
      } else if (frame.kind === 'cancel') {
        pending.get(frame.requestId)?.abort();
      } else if (frame.kind === 'request' && !pending.has(frame.requestId)) {
        const call = new AbortController();
        pending.set(frame.requestId, call);
        try {
          const value = await command(frame.method, frame.args, call.signal);
          call.signal.throwIfAborted();
          send({ kind: 'reply', requestId: frame.requestId, outcome: { status: 'ok', value } });
        }
        catch (error) { send({ kind: 'reply', requestId: frame.requestId, outcome: { status: 'failed', failure: {
          code: call.signal.aborted ? 'cancelled' : 'gateway-command-failed', message: error.message,
          ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          ...(error.failureCode ? { failureCode: error.failureCode } : {}),
        } } }); }
        finally { pending.delete(frame.requestId); }
      }
    };
    const cleanup = () => {
      if (controller.signal.aborted) return;
      controller.abort(); streams.delete(controller);
      for (const call of pending.values()) call.abort();
      pending.clear();
      lifetime.signal.removeEventListener('abort', dispose);
      port.off('message', receive); port.off('close', cleanup);
      if (!streams.size && !lifetime.signal.aborted) updateState('reconnecting');
    };
    const dispose = () => { if (!controller.signal.aborted) { cleanup(); port.close(); } };
    lifetime.signal.addEventListener('abort', dispose, { once: true });
    port.on('message', receive); port.on('close', cleanup); port.start();
    return dispose;
  }
  return { command, request, attach, getState: () => state, close };
}
