// Messages from one model response must reach the user in the order the model wrote them.
// The model layer hands the Harness a response's tool calls together, and the Harness then
// runs them concurrently (each first awaits its own durable journal admission), so without
// this the shortest message tends to arrive first. Other tools keep running in parallel.

const ORDERED_TOOLS = new Set(['SendToUser', 'SendToAgent']);
// A predecessor that never executes (for example, rejected arguments) must not block forever.
const MAX_WAIT_MS = 15_000;
const STALE_MS = 10 * 60_000;
const calls = new Map();
// Some providers number call IDs per response, so concurrent conversations can reuse an ID. Such
// calls run unordered (as without this module) instead of failing the turn or waiting on each other.
// The colliding calls finish well within a minute; after that the ID is ordered normally again.
const SHARED_MS = 60_000;
const shared = new Map();
let sweepTimer;

function release(id, entry) {
  entry.resolve();
  if (calls.get(id) === entry) calls.delete(id);
  if (!calls.size) { clearTimeout(sweepTimer); sweepTimer = undefined; }
}

// One unreferenced timer for the whole map, including when the last turn is abandoned.
function scheduleSweep() {
  if (sweepTimer || !calls.size) return;
  const first = calls.values().next().value;
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    const now = Date.now();
    for (const [id, entry] of calls) {
      if (entry.createdAt + STALE_MS > now) break;
      release(id, entry);
    }
    scheduleSweep();
  }, Math.max(1, first.createdAt + STALE_MS - Date.now()));
  sweepTimer.unref?.();
}

/** Called by the model layer with one response's tool calls in written order. */
export function recordToolCallOrder(list) {
  const now = Date.now();
  for (const [id, until] of shared) if (until <= now) shared.delete(id);
  const registered = new Map();
  const ordered = list.filter(({ toolCallId, toolName }) => ORDERED_TOOLS.has(toolName) && typeof toolCallId === 'string' && toolCallId);
  const ids = new Set();
  for (const { toolCallId } of ordered) {
    if (ids.has(toolCallId)) throw new Error('Ordered tool call ID is repeated in one response');
    ids.add(toolCallId);
  }
  let previous;
  for (const { toolCallId } of ordered) {
    const existing = calls.get(toolCallId);
    if (existing || shared.has(toolCallId)) {
      // Neither response may take over or wait on the other's entry for an ambiguous ID.
      if (existing) release(toolCallId, existing);
      shared.set(toolCallId, now + SHARED_MS);
      continue;
    }
    let resolve;
    const done = new Promise(settle => { resolve = settle; });
    const entry = { previous, done, resolve, createdAt: now };
    calls.set(toolCallId, entry);
    registered.set(toolCallId, entry);
    previous = done;
  }
  scheduleSweep();
  return id => { const entry = registered.get(id); if (entry) release(id, entry); };
}

/** Wait for the previous ordered call of the same response; the returned function marks this call finished. */
export function awaitToolCallTurn(toolCallId, signal, { maxWaitMs = MAX_WAIT_MS } = {}) {
  const entry = calls.get(toolCallId);
  if (!entry) return Promise.resolve(() => {});
  return (async () => {
    const previous = entry.previous;
    if (previous && !signal?.aborted) {
      let timer, onAbort;
      await Promise.race([previous,
        new Promise(settle => { timer = setTimeout(settle, maxWaitMs); }),
        new Promise(settle => { onAbort = settle; signal?.addEventListener('abort', settle, { once: true }); })]);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    return () => release(toolCallId, entry);
  })();
}
