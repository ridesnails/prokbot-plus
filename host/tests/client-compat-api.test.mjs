import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientCompatMethods,
  handleClientCompatRpc,
} from '../server/client-compat-api.mjs';
import { HttpError } from '../server/security.mjs';

/** Simulate official d0a4baa readTranscriptWindow: `seq` lives on the DB row, NOT on the parsed entry JSON. */
function createOfficialTranscriptHost(rows) {
  return async (method, args) => {
    assert.equal(method, 'getAgentTranscriptWindow');
    const upper = typeof args.beforeSeq === 'number' ? args.beforeSeq : Number.POSITIVE_INFINITY;
    const eligible = rows.filter(row => row.seq < upper);
    const slice = eligible.slice(-args.limit);
    const oldestSeq = slice[0]?.seq;
    const hasEarlier = oldestSeq !== undefined && rows.some(row => row.seq < oldestSeq);
    return {
      entries: slice.map(row => row.entry),
      ...(hasEarlier ? { nextBeforeSeq: oldestSeq } : {}),
      threadCounts: {},
    };
  };
}

test('client-compat-api only registers Host-forwarded RPCs and handles automations, skill targets, and errors', async () => {
  assert.deepEqual(
    [...clientCompatMethods].sort(),
    [
      'rerunAutomationFromCard',
      'resolveSkillPublishTargets',
      'runAutomationWebhook',
      'searchConversation',
    ],
  );
  for (const localMethod of [
    'getServerAgentRoster',
    'getMainAgent',
    'setMainAgent',
    'ensureDefaultMainAgent',
    'dismissAgentSuggestions',
    'confirmTeachLearningPrompt',
    'takeTeachLearningPrompts',
    'resolveAgentCreation',
    'restoreTemporalAgentRouting',
    'noteMountedAgent',
    'noteTranscriptOpened',
    'searchMessages',
    'searchFiles',
  ]) {
    assert.equal(clientCompatMethods.has(localMethod), false);
  }

  const calls = [];
  const fakeHost = async (method, args) => {
    calls.push({ method, args });
    if (method === 'getAgentTranscriptWindow') {
      if (args.beforeSeq === 100) {
        return {
          entries: [
            { id: 'e0', role: 'user', timestampMs: 500, text: 'Older ProkBot history hit' },
          ],
          threadCounts: {},
        };
      }
      return {
        nextBeforeSeq: 100,
        entries: [
          { id: 'e1', role: 'user', timestampMs: 1000, text: 'hello world' },
          { id: 'e2', role: 'assistant', timestampMs: 2000, parts: [{ text: 'ProkBot status check complete' }] },
          { id: 'e3', kind: 'send-message', timestampMs: 3000, message: { type: 'text', content: 'ProkBot nested reply ok' } },
        ],
        threadCounts: {},
      };
    }
    if (method === 'getAgentAutomations') {
      return [{ id: 'auto-1', name: 'Daily digest' }];
    }
    if (method === 'runAgentAutomationNow') return { ok: true };
    throw new Error(`unexpected host call: ${method}`);
  };

  assert.deepEqual(await handleClientCompatRpc('resolveSkillPublishTargets', {}, fakeHost), { targets: [] });

  // Invalid agentId rejected cleanly
  await assert.rejects(
    () => handleClientCompatRpc('searchConversation', { agentId: '../etc/passwd', query: 'x' }, fakeHost),
    err => err instanceof HttpError && err.status === 400,
  );
  await assert.rejects(
    () => handleClientCompatRpc('rerunAutomationFromCard', { id: 'a1', automationId: '' }, fakeHost),
    err => err instanceof HttpError && err.status === 400,
  );

  // Automations verify existence via getAgentAutomations; webhook fails closed with HTTP 501
  const rerun = await handleClientCompatRpc('rerunAutomationFromCard', { id: 'a1', automationId: 'auto-1', entryId: 'e9' }, fakeHost);
  assert.deepEqual(rerun, { ok: true, result: 'started', id: 'a1', automationId: 'auto-1' });
  assert.deepEqual(calls.at(-1), { method: 'runAgentAutomationNow', args: { id: 'a1', automationId: 'auto-1' } });

  const missingRerun = await handleClientCompatRpc('rerunAutomationFromCard', { id: 'a1', automationId: 'missing-auto' }, fakeHost);
  assert.deepEqual(missingRerun, { ok: false, result: 'not_offered', id: 'a1', automationId: 'missing-auto' });

  await assert.rejects(
    () => handleClientCompatRpc('runAutomationWebhook', { id: 'a1', automationId: 'auto-1', context: 'ctx' }, fakeHost),
    err => err instanceof HttpError && err.status === 501,
  );
  await assert.rejects(
    () => handleClientCompatRpc('runAutomationWebhook', { id: '../bad', automationId: 'auto-1' }, fakeHost),
    err => err instanceof HttpError && err.status === 400,
  );

  // Multi-page searchConversation using official nextBeforeSeq (no entry.seq, no hasMore)
  const found = await handleClientCompatRpc('searchConversation', { agentId: 'a1', query: 'prokbot', limit: 10 }, fakeHost);
  assert.equal(found.isComplete, true);
  assert.equal('nextBeforeSeq' in found, false);
  assert.deepEqual(found.matches.map(m => m.entryId), ['e3', 'e2', 'e0']);

  // Reaching limit mid-page still scans the whole page and returns page.nextBeforeSeq as cursor
  const limited = await handleClientCompatRpc('searchConversation', { agentId: 'a1', query: 'prokbot', limit: 1 }, fakeHost);
  assert.deepEqual(limited.matches.map(m => m.entryId), ['e3', 'e2']);
  assert.equal(limited.isComplete, false);
  assert.equal(limited.nextBeforeSeq, 100);

  const page2 = await handleClientCompatRpc(
    'searchConversation',
    { agentId: 'a1', query: 'prokbot', limit: 1, beforeSeq: limited.nextBeforeSeq },
    fakeHost,
  );
  assert.deepEqual(page2.matches.map(m => m.entryId), ['e0']);
  assert.equal(page2.isComplete, true);
  assert.equal('nextBeforeSeq' in page2, false);
});

test('searchConversation does not drop remaining matches when hitting limit mid-page (30 official entries, limit 2)', async () => {
  // 30 entries all fit in one 200-row window; 10 of them match, and entries have NO `seq` field.
  const rows = Array.from({ length: 30 }, (_, idx) => {
    const seq = idx + 1;
    const isHit = seq % 3 === 0;
    return {
      seq,
      entry: {
        id: `entry-${seq}`,
        role: idx % 2 === 0 ? 'user' : 'assistant',
        timestampMs: 1_700_000_000_000 + seq * 1000,
        text: isHit ? `target-keyword hit #${seq}` : `filler message ${seq}`,
      },
    };
  });

  const result = await handleClientCompatRpc(
    'searchConversation',
    { agentId: 'a1b2', query: 'target-keyword', limit: 2 },
    createOfficialTranscriptHost(rows),
  );
  assert.equal(result.isComplete, true);
  assert.equal('nextBeforeSeq' in result, false);
  assert.deepEqual(
    result.matches.map(m => m.entryId),
    ['entry-30', 'entry-27', 'entry-24', 'entry-21', 'entry-18', 'entry-15', 'entry-12', 'entry-9', 'entry-6', 'entry-3'],
  );
});

test('searchConversation retrieves 100% of matches across multi-page pagination (450 official entries, limit 2)', async () => {
  // 450 rows across 3 windows (251..450, 51..250, 1..50); 9 hits (every 50th row), no `seq` in entries.
  const rows = Array.from({ length: 450 }, (_, idx) => {
    const seq = idx + 1;
    const isHit = seq % 50 === 0;
    return {
      seq,
      entry: {
        id: `entry-${seq}`,
        role: idx % 2 === 0 ? 'user' : 'assistant',
        timestampMs: 1_700_000_000_000 + seq * 1000,
        text: isHit ? `needle-multi-page at ${seq}` : `ordinary line ${seq}`,
      },
    };
  });

  const host = createOfficialTranscriptHost(rows);
  const collected = [];
  let beforeSeq = undefined;
  let pages = 0;

  while (true) {
    pages++;
    assert.ok(pages <= 10, 'pagination loop should terminate cleanly');
    const page = await handleClientCompatRpc(
      'searchConversation',
      { agentId: 'a1b2', query: 'needle-multi-page', limit: 2, ...(beforeSeq !== undefined ? { beforeSeq } : {}) },
      host,
    );
    collected.push(...page.matches.map(m => m.entryId));
    if (page.isComplete) {
      assert.equal('nextBeforeSeq' in page, false);
      break;
    }
    assert.equal(typeof page.nextBeforeSeq, 'number');
    beforeSeq = page.nextBeforeSeq;
  }

  assert.equal(pages, 3);
  assert.deepEqual(
    collected,
    ['entry-450', 'entry-400', 'entry-350', 'entry-300', 'entry-250', 'entry-200', 'entry-150', 'entry-100', 'entry-50'],
  );
});

test('searchConversation traverses 1000 official-shape entries to find match at #11 and propagates Host errors', async () => {
  const rows = Array.from({ length: 1000 }, (_, idx) => {
    const seq = idx + 1;
    return {
      seq,
      entry: {
        id: `entry-${seq}`,
        role: idx % 2 === 0 ? 'user' : 'assistant',
        timestampMs: 1_700_000_000_000 + seq * 1000,
        text: seq === 11 ? 'needle-at-entry-11 found deep in history' : `ordinary message ${seq}`,
      },
    };
  });

  const result = await handleClientCompatRpc(
    'searchConversation',
    { agentId: 'a1b2', query: 'needle-at-entry-11', limit: 10 },
    createOfficialTranscriptHost(rows),
  );
  assert.equal(result.isComplete, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].entryId, 'entry-11');

  // Host 503/404 errors must propagate instead of returning an empty complete result.
  await assert.rejects(
    () => handleClientCompatRpc(
      'searchConversation',
      { agentId: 'a1b2', query: 'anything' },
      async () => { throw new HttpError(503, 'Host unavailable'); },
    ),
    err => err instanceof HttpError && err.status === 503,
  );
});
