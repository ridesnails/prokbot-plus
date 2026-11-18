import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeAgent } from '../runtime/host-summarize.mjs';

function fixture({ running = false, runResult = {}, runError } = {}) {
  const agentId = '7bbf2710-6f8d-4393-a952-7c6392719ff6';
  const session = { id: agentId }, calls = [];
  const original = async () => ({ action: 'original' });
  const runner = {
    promptGlue: { assembleTurnAction: original },
    async run(prompt, options) {
      calls.push({ type: 'run', prompt, options, action: await this.promptGlue.assembleTurnAction({}) });
      if (runError) throw runError;
      return runResult;
    },
  };
  const lifecycle = {
    inFlightRunCounts: new Map(running ? [[session, 1]] : []),
    runningAgentIds() { return new Set([...this.inFlightRunCounts.keys()].map(item => item.id)); },
    beginSessionRun(value) { calls.push({ type: 'begin', session: value }); this.inFlightRunCounts.set(value, 1); },
    endSessionRun(value) { calls.push({ type: 'end', session: value }); this.inFlightRunCounts.delete(value); },
    async enqueueExclusiveRun(id, task, options) { calls.push({ type: 'enqueue', id, options }); return task(); },
  };
  const host = { transcript: {
    listAgentsSync: () => [{ id: agentId, name: '测试 Bot', isGroup: false }],
    sessions: { resolveBackgroundSession: async id => { calls.push({ type: 'resolve', id }); return session; } },
    runnerRegistry: { getRunner: value => { calls.push({ type: 'runner', session: value }); return runner; } },
    runLifecycle: lifecycle,
    roster: { emitAgentUpdate: async id => { calls.push({ type: 'update', id }); } },
  } };
  // The actual Host public library exports neither generated action constructor.
  return { agentId, host, library: {}, runner, original, lifecycle, calls };
}

test('manual summarization runs the native summarizeAction and restores prompt glue', async () => {
  const value = fixture();
  const result = await summarizeAgent(value.host, value.library, value.agentId);
  assert.deepEqual(result, { ok: true, agentId: value.agentId, status: 'completed' });
  const run = value.calls.find(item => item.type === 'run');
  assert.match(run.prompt, /conversation summary/);
  assert.deepEqual(run.options, { hidden: true, requestSource: 'event', advanceChainOnDelivery: false });
  assert.equal(run.action.action.action.case, 'summarizeAction');
  assert.deepEqual(run.action.action.action.value, {});
  assert.equal(value.runner.promptGlue.assembleTurnAction, value.original);
  assert.equal(value.lifecycle.inFlightRunCounts.size, 0);
  assert.deepEqual(value.calls.filter(item => item.type === 'enqueue')[0].options, { lane: 'background', source: 'manual-summary' });
});

test('manual summarization refuses a Bot with an active run', async () => {
  const value = fixture({ running: true });
  await assert.rejects(summarizeAgent(value.host, value.library, value.agentId), error => error.status === 409);
  assert.equal(value.calls.some(item => item.type === 'runner'), false);
  assert.equal(value.calls.some(item => item.type === 'begin'), false);
});

test('manual summarization restores prompt glue and lifecycle state after failure', async () => {
  const failure = new Error('upstream unavailable'), value = fixture({ runError: failure });
  await assert.rejects(summarizeAgent(value.host, value.library, value.agentId), failure);
  assert.equal(value.runner.promptGlue.assembleTurnAction, value.original);
  assert.equal(value.lifecycle.inFlightRunCounts.size, 0);
  assert.equal(value.calls.filter(item => item.type === 'end').length, 1);
  assert.equal(value.calls.filter(item => item.type === 'update').length, 1);
});

test('an interrupted manual summary does not report completion', async () => {
  const value = fixture({ runResult: { aborted: true } });
  await assert.rejects(summarizeAgent(value.host, value.library, value.agentId), error => error.status === 409);
  assert.equal(value.runner.promptGlue.assembleTurnAction, value.original);
  assert.equal(value.lifecycle.inFlightRunCounts.size, 0);
});
