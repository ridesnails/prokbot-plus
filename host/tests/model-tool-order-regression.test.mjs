import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createModelSession } from '../runtime/model-session.mjs';
import { awaitToolCallTurn, recordToolCallOrder } from '../runtime/reliability/tool-order.mjs';

const call = id => ({ toolName: 'SendToUser', toolCallId: id });

test('abandoning a streamed tool batch releases only the calls not handed to the Harness', async () => {
  const ids = ['delivered-first', 'delivered-second', 'never-delivered'];
  const data = { choices: [{ delta: { tool_calls: ids.map((id, index) => ({ id, index,
    function: { name: 'SendToUser', arguments: '{}' } })) }, finish_reason: 'tool_calls' }] };
  const session = createModelSession({ model: 'fixture', baseUrl: 'http://127.0.0.1',
    fetchImpl: () => new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`) });
  const controller = new AbortController();
  const result = session.getExecutor([{ role: 'user', content: 'fixture' }]).stream({ signal: controller.signal }, 'turn', []);
  const releases = [];
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await result.fullStream.next()).value.type, 'tool-call-streaming-start');
      assert.equal((await result.fullStream.next()).value.type, 'tool-call-delta');
      assert.equal((await result.fullStream.next()).value.toolCallId, ids[i]);
    }
    assert.equal((await result.fullStream.next()).value.type, 'tool-call-streaming-start');
    controller.abort();
    await result.fullStream.return();
    let secondReady = false, thirdReady = false;
    const second = awaitToolCallTurn(ids[1], undefined, { maxWaitMs: 1000 }).then(release => { secondReady = true; releases.push(release); });
    const third = awaitToolCallTurn(ids[2], undefined, { maxWaitMs: 1000 }).then(release => { thirdReady = true; releases.push(release); });
    await tick();
    const before = [secondReady, thirdReady];
    (await awaitToolCallTurn(ids[0]))();
    await second;
    releases.forEach(release => release());
    await third;
    assert.deepEqual(before, [false, true], 'only the already delivered second message should still wait');
  } finally {
    releases.forEach(release => release());
    await result.fullStream.return();
  }
});

test('unclaimed ordering entries expire during an idle period without another model turn', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const ids = ['idle-first', 'idle-next'];
  recordToolCallOrder(ids.map(call));
  t.mock.timers.tick(10 * 60_000 + 1);
  let ready = false;
  const waiting = awaitToolCallTurn(ids[1], undefined, { maxWaitMs: 500 }).then(release => { ready = true; release(); });
  await tick();
  const atExpiry = ready;
  (await awaitToolCallTurn(ids[0]))();
  await waiting;
  assert.equal(atExpiry, true, 'an expired predecessor must not start a fresh wait');
});

test('a concurrent response cannot take over a live ordered call ID, and neither turn fails', async () => {
  recordToolCallOrder(['before-shared', 'live-shared'].map(call));
  recordToolCallOrder(['new-head', 'live-shared'].map(call));
  // The ambiguous ID waits on neither head: the first response's predecessor is still running.
  const releaseHead = await awaitToolCallTurn('before-shared');
  const started = Date.now();
  (await awaitToolCallTurn('live-shared', undefined, { maxWaitMs: 5000 }))();
  assert.ok(Date.now() - started < 1000);
  releaseHead(); (await awaitToolCallTurn('new-head'))();
  recordToolCallOrder([call('live-shared')]);
  (await awaitToolCallTurn('live-shared'))();
});
