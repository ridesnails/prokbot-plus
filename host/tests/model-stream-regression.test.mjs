import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { errorFromResponse, readSse } from '../runtime/model-common.mjs';
import { createHarnessModelErrorMapper } from '../runtime/model-errors.mjs';
import { awaitToolCallTurn } from '../runtime/reliability/tool-order.mjs';
import { API_FORMATS, createModelSession } from '../runtime/model-session.mjs';

const history = [{ role: 'user', content: 'Synthetic stream check.' }];
const tools = [{ name: 'record', parameters: { type: 'object', properties: { value: { type: 'integer' } } } }];
const slots = ['response', 'usage', 'extendedUsage', 'providerMetadata', 'invocationId'];
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const frames = events => events.map(frame).join('');
const choice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const completed = response => ({ type: 'response.completed', response: { status: 'completed', ...response } });
const functionItem = (id, index) => ({ type: 'function_call', id: `item_${index}`, call_id: id,
  name: 'record', arguments: JSON.stringify({ value: index }) });

function toolEvents(format, ids = ['one']) {
  if (format === 'openai') return ids.map((id, index) => choice({ tool_calls: [
    { index, id, function: { name: 'record', arguments: JSON.stringify({ value: index }) } }] }));
  if (format === 'openai-responses') return ids.map((id, index) => ({ type: 'response.output_item.done',
    output_index: index, item: functionItem(id, index) }));
  return [{ type: 'message_start', message: { id: 'msg', usage: { input_tokens: 2 } } },
    ...ids.flatMap((id, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'record', input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ value: index }) } },
      { type: 'content_block_stop', index },
    ])];
}

function ending(format) {
  if (format === 'openai') return [choice({}, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }, '[DONE]'];
  if (format === 'openai-responses') return [completed({ usage: { input_tokens: 2, output_tokens: 3 } })];
  return [{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }];
}

function messageEvents(format, id, args) {
  const name = 'SendToUser', json = JSON.stringify(args);
  if (format === 'openai') return [choice({ tool_calls: [{ index: 0, id, function: { name, arguments: json } }] })];
  if (format === 'openai-responses') return [{ type: 'response.output_item.done', output_index: 0,
    item: { type: 'function_call', id: `item_${id}`, call_id: id, name, arguments: json } }];
  return [{ type: 'message_start', message: { id: `msg_${id}`, usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name, id, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
    { type: 'content_block_stop', index: 0 }];
}

function sentHistory(args) {
  const toolName = 'SendToUser', toolCallId = 'first-reply';
  return [...history, { role: 'assistant', id: 'response-first', content: [{ type: 'tool-call', toolName, toolCallId, args }] },
    { role: 'tool', id: toolCallId, content: [{ type: 'tool-result', toolName, toolCallId, result: 'Message sent.' }],
      providerOptions: { cursor: { highLevelToolCallResult: { isError: false } } } }];
}

async function loopback(t, reply) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ path: req.url, body: JSON.parse(text) });
    reply(res, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function stream(apiFormat, baseUrl, config, signal) {
  return createModelSession({ model: 'fixture', apiFormat, baseUrl, ...config })
    .getExecutor(history).stream({ signal }, 'fixture-turn', tools);
}

async function rejectedSlots(result, reason) {
  for (const key of slots) await assert.rejects(result[key], error => error === reason, key);
}

async function rejectedTurn(result, expected) {
  const emitted = [];
  let reason;
  try { for await (const part of result.fullStream) emitted.push(part.type); } catch (error) { reason = error; }
  assert.ok(reason, `Unexpected success: ${emitted.join(', ')}`);
  if (expected instanceof RegExp) assert.match(reason.message, expected);
  else expected(reason);
  assert.ok(!emitted.some(type => type === 'finish' || type.startsWith('tool-call')), `Leaked: ${emitted.join(', ')}`);
  await rejectedSlots(result, reason);
}

test('oversized provider error bodies stop reading and retain HTTP retry information', async () => {
  const chunk = new Uint8Array(8192).fill(32);
  for (const headers of [{}, { 'content-length': '1' }]) {
    let pulled = 0, cancelled = false;
    const body = new ReadableStream({
      pull(c) { if (++pulled <= 12) c.enqueue(chunk); else c.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const e = await errorFromResponse(new Response(body, { status: 429, headers: { ...headers, 'retry-after': '2' } }));
    assert.equal(e.status, 429); assert.equal(e.retryAfterMs, 2000);
    assert.ok(pulled <= 9 && cancelled && !body.locked, `pulled ${pulled}, cancelled ${cancelled}`);
    assert.match(e.message, /429.*64 KiB/); assert.equal(e.code, undefined);
  }
});

test('provider error body exactly at the limit preserves code, parameter and redaction', async () => {
  const credential = 'synthetic-private-token';
  const text = JSON.stringify({ error: { message: `Unknown field. ${credential}`, param: 'effort', code: 'invalid_request_error' } });
  const bytes = Buffer.from(text.padEnd(64 * 1024));
  const body = new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 31)); c.enqueue(bytes.subarray(31)); c.close(); } });
  const e = await errorFromResponse(new Response(body, { status: 400 }), credential);
  assert.equal(e.code, 'invalid_request_error'); assert.equal(e.param, 'effort');
  assert.equal(e.message, 'Unknown field. [redacted]'); assert.equal(body.locked, false);
});

test('provider error body read failures preserve transport errors; empty and non-JSON keep HTTP status', async () => {
  for (const data of [null, '', '<html>bad gateway']) {
    const e = await errorFromResponse(new Response(data, { status: 502 }));
    assert.equal(e.message, 'Model request failed (HTTP 502)');
  }
  const cause = new Error('reply interrupted');
  const body = new ReadableStream({ start(c) { c.error(cause); } });
  await assert.rejects(errorFromResponse(new Response(body, { status: 502 })), error => error === cause);
  assert.equal(body.locked, false);
});

for (const format of API_FORMATS) {
  test(`${format}: an autonomous repeated plain-text delivery fails visibly before any tool handoff`, async t => {
    const args = { type: 'text', content: 'Synthetic reply.' }, id = `${format}-resend`, usage = [];
    const { baseUrl, requests } = await loopback(t, res => res.end(frames([...messageEvents(format, id,
      { content: args.content, type: args.type }), ...ending(format)])));
    class NonRetriableError extends Error { constructor(msg, options) { super(msg, options); this.displayInfo = options.displayInfo; } }
    const mapError = createHarnessModelErrorMapper({ Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
      NonRetriableError, ConnectError: Error, ActionRequiredError: Error });
    const result = createModelSession({ model: 'fixture', apiFormat: format, baseUrl, mapError, onUsage: u => usage.push(u) })
      .getExecutor(sentHistory(args)).stream({}, 'next-step', []);
    await rejectedTurn(result, e => {
      assert.ok(e instanceof NonRetriableError); assert.equal(e.cause.code, 'repeated_user_delivery');
      assert.equal(e.displayInfo.isRetryable, false); assert.match(e.message, /already delivered/i);
      assert.ok(!e.message.includes(args.content));
    });
    assert.equal(requests.length, 1); assert.equal(usage.length, 1, 'the upstream generation was billed');
    const body = JSON.stringify(requests[0].body); assert.ok(body.includes('first-reply') && body.includes('Message sent.'));
  });

  test(`${format}: new user turns, different text and unsuccessful deliveries are not suppressed`, async () => {
    const args = { type: 'text', content: 'Same answer.' };
    const examples = [
      msgs => msgs.push({ role: 'user', content: 'Please repeat that.' }),
      msgs => { msgs[1].content[0].args = { ...args, content: 'A different answer.' }; },
      msgs => { msgs[2].providerOptions.cursor.highLevelToolCallResult.isError = true; },
      msgs => { delete msgs[2].providerOptions; },
      msgs => { msgs[2].content[0].toolCallId = 'unrelated-result'; },
      msgs => { msgs[1].content[0].args = { ...args, attachment: 'different' }; },
    ];
    for (const [i, edit] of examples.entries()) {
      const msgs = sentHistory(args); edit(msgs); const id = `${format}-allowed-${i}`;
      const fetchImpl = async () => new Response(frames([...messageEvents(format, id, args), ...ending(format)]));
      const result = createModelSession({ model: 'fixture', apiFormat: format, baseUrl: 'http://127.0.0.1', fetchImpl })
        .getExecutor(msgs).stream({}, 'next-step', []);
      try { assert.deepEqual((await Array.fromAsync(result.fullStream)).filter(p => p.type === 'tool-call').map(p => p.toolCallId), [id]); }
      finally { (await awaitToolCallTurn(id))(); }
    }
  });

  test(`${format}: EOF before the terminal event does not publish a tool or retry`, async t => {
    // Chat accepts either [DONE] or a finish reason, so its truncated stream carries neither.
    const cut = format === 'openai' ? ending(format).slice(1, -1) : ending(format).slice(0, -1);
    const { baseUrl, requests } = await loopback(t, res => res.end(frames([...toolEvents(format), ...cut])));
    await rejectedTurn(stream(format, baseUrl), /completion marker/i);
    assert.equal(requests.length, 1);
  });

  test(`${format}: EOF in the final SSE frame cannot certify the turn`, async t => {
    const [finish, usage] = ending(format);
    const last = format === 'openai' ? [usage, finish] : ending(format);
    const wire = frames([...toolEvents(format), ...last]).slice(0, -1);
    const { baseUrl } = await loopback(t, res => res.end(wire));
    await rejectedTurn(stream(format, baseUrl), /completion marker/i);
  });

  test(`${format}: duplicate IDs reject the whole tool batch before handoff`, async t => {
    const wire = frames([...toolEvents(format, ['same', 'same']), ...ending(format)]);
    const { baseUrl, requests } = await loopback(t, res => res.end(wire));
    await rejectedTurn(stream(format, baseUrl), /duplicate.*tool/i);
    assert.equal(requests.length, 1);
  });

  test(`${format}: valid parallel tools are handed off once in output order`, async t => {
    const wire = frames([...toolEvents(format, ['first', 'second']), ...ending(format)]);
    const { baseUrl, requests } = await loopback(t, res => res.end(wire));
    const result = stream(format, baseUrl), parts = await Array.fromAsync(result.fullStream);
    const calls = parts.filter(part => part.type === 'tool-call');
    assert.deepEqual(calls.map(part => [part.toolCallId, part.args]), [['first', { value: 0 }], ['second', { value: 1 }]]);
    assert.deepEqual((await result.response).messages[0].content, calls);
    assert.equal(parts.at(-1).finishReason, 'tool-calls');
    assert.equal((await result.usage).totalTokens, 5);
    assert.equal(requests.length, 1);
  });

  test(`${format}: abort while the consumer is paused stops the buffered tool batch`, async t => {
    const wire = frames([...toolEvents(format, ['first', 'second']), ...ending(format)]);
    const { baseUrl, requests } = await loopback(t, res => res.end(wire));
    const controller = new AbortController(), reason = new Error('fixture caller canceled');
    const result = stream(format, baseUrl, {}, controller.signal);
    try {
      assert.equal((await result.fullStream.next()).value.type, 'tool-call-streaming-start');
      controller.abort(reason);
      await assert.rejects(result.fullStream.next(), error => error === reason);
      await rejectedSlots(result, reason);
      assert.equal(requests.length, 1);
    } finally { await result.fullStream.return(); }
  });
}

test('Messages rejects a terminal delimiter with no semantic stop reason', async t => {
  const { baseUrl } = await loopback(t, res => res.end(frames([...toolEvents('anthropic'), ending('anthropic').at(-1)])));
  await rejectedTurn(stream('anthropic', baseUrl), /finish reason|stop reason|completion marker/i);
});

test('Chat accepts the completion markers and tool calls of lenient compatible endpoints', async t => {
  const usage = { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } };
  const emptyArgs = choice({ tool_calls: [{ index: 0, id: 'bare', function: { name: 'record', arguments: '' } }] });
  const cases = [
    ['[DONE] without a finish reason', [...toolEvents('openai'), usage, '[DONE]'], [['one', { value: 0 }]]],
    ['a finish reason without [DONE]', [...toolEvents('openai'), choice({}, 'tool_calls'), usage], [['one', { value: 0 }]]],
    ['"stop" after tool calls', [...toolEvents('openai'), choice({}, 'stop'), usage, '[DONE]'], [['one', { value: 0 }]]],
    ['an empty argument string', [emptyArgs, choice({}, 'tool_calls'), usage, '[DONE]'], [['bare', {}]]],
  ];
  for (const [label, events, expected] of cases) {
    const { baseUrl } = await loopback(t, res => res.end(frames(events)));
    const parts = await Array.fromAsync(stream('openai', baseUrl).fullStream);
    assert.deepEqual(parts.filter(p => p.type === 'tool-call').map(p => [p.toolCallId, p.args]), expected, label);
  }
  const { baseUrl } = await loopback(t, res => res.end(frames([choice({ content: 'Done.' }), choice({}, 'eos'), '[DONE]'])));
  const parts = await Array.fromAsync(stream('openai', baseUrl).fullStream);
  assert.equal(parts.filter(p => p.type === 'text-delta').map(p => p.textDelta).join(''), 'Done.', 'an unlisted finish reason');
});

test('Chat preserves in-stream provider errors and Retry-After after buffered arguments', async t => {
  const { baseUrl, requests } = await loopback(t, res => {
    res.setHeader('retry-after', '2');
    res.end(frames([...toolEvents('openai'), { error: { message: 'Synthetic throttle', status: 429, code: 'rate_limit_exceeded' } }]));
  });
  await rejectedTurn(stream('openai', baseUrl), error => {
    assert.equal(error.message, 'Synthetic throttle');
    assert.equal(error.code, 'rate_limit_exceeded');
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 2000);
  });
  assert.equal(requests.length, 1);
});

test('Responses checks the terminal status before publishing any tool', async t => {
  const { baseUrl } = await loopback(t, res => res.end(frames([...toolEvents('openai-responses'),
    completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })])));
  await rejectedTurn(stream('openai-responses', baseUrl), error => assert.equal(error.code, 'length'));
});

test('Responses reconciles the final snapshot without losing text or duplicating a tool', async t => {
  const message = { type: 'message', id: 'msg', content: [{ type: 'output_text', text: 'partial reply' }] };
  const { baseUrl } = await loopback(t, res => res.end(frames([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
    { type: 'response.output_item.done', output_index: 1, item: functionItem('first', 1) },
    completed({ output: [message, functionItem('first', 1), functionItem('second', 2)] }),
  ])));
  const result = stream('openai-responses', baseUrl), parts = await Array.fromAsync(result.fullStream);
  assert.equal(parts.filter(part => part.type === 'text-delta').map(part => part.textDelta).join(''), 'partial reply');
  assert.deepEqual(parts.filter(part => part.type === 'tool-call').map(part => part.toolCallId), ['first', 'second']);
  assert.equal((await result.response).messages[0].content[0].text, 'partial reply');
});

test('an unrelated HTTP 400 naming an absent option is not retried', async t => {
  const { baseUrl, requests } = await loopback(t, res => {
    res.writeHead(400); res.end(JSON.stringify({ error: { param: 'tools[0].parameters', message: 'Example mentions max_tokens' } }));
  });
  await rejectedTurn(stream('openai', baseUrl), error => assert.equal(error.status, 400));
  assert.equal(requests.length, 1);
});

test('a recognized HTTP 400 fallback precedes the stream and publishes only one tool', async t => {
  const { baseUrl, requests } = await loopback(t, (res, attempt) => {
    if (attempt === 1) { res.writeHead(400); res.end(JSON.stringify({ error: { param: 'stream_options', message: 'Unsupported option' } })); }
    else res.end(frames([...toolEvents('openai'), ...ending('openai')]));
  });
  const parts = await Array.fromAsync(stream('openai', baseUrl).fullStream);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.stream_options.include_usage, true);
  assert.equal(requests[1].body.stream_options, undefined);
  assert.deepEqual(parts.filter(part => part.type === 'tool-call').map(part => part.toolCallId), ['one']);
});

for (const phase of ['headers', 'SSE read', 'HTTP error body']) {
  test(`a stalled ${phase} times out, closes the socket and does not retry`, async t => {
    const closed = Promise.withResolvers();
    const { baseUrl, requests } = await loopback(t, res => {
      res.on('close', closed.resolve);
      if (phase !== 'headers') { res.writeHead(phase === 'SSE read' ? 200 : 400); res.write(phase === 'SSE read' ? 'data: ' : '{'); }
    });
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new Error('test watchdog: upstream did not time out')), 1500);
    try {
      await rejectedTurn(stream('openai', baseUrl, { idleTimeoutMs: 200 }, controller.signal), error => assert.equal(error.name, 'TimeoutError'));
      await closed.promise;
      assert.equal(requests.length, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { clearTimeout(watchdog); }
  });
}

test('backpressure does not pull extra chunks or count consumer delay as upstream idle', async t => {
  const wire = [frame(choice({ content: 'one' })), frame(choice({ content: 'two' }, 'stop')), frame('[DONE]')];
  let pulls = 0, cancels = 0;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from(wire[pulls++])); }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const result = stream('openai', 'http://127.0.0.1', { fetchImpl: () => new Response(body), idleTimeoutMs: 50 });
  t.after(() => result.fullStream.return());
  assert.equal((await result.fullStream.next()).value.textDelta, 'one');
  await delay(100);
  assert.equal(pulls, 1);
  const rest = await Array.fromAsync(result.fullStream);
  assert.equal(rest[0].textDelta, 'two');
  assert.equal(rest.at(-1).type, 'finish');
  assert.equal(cancels, 1);
  assert.equal(body.locked, false);
});

test('consumers stopping at finish leave no listeners and record usage exactly once per turn', async () => {
  const controller = new AbortController(), streams = [];
  let records = 0;
  const session = createModelSession({ model: 'fixture', baseUrl: 'http://127.0.0.1', onUsage: () => { records++; },
    fetchImpl: () => new Response(frames([choice({ content: 'ok' }, 'stop'), { choices: [], usage: { prompt_tokens: 1 } }, '[DONE]'])) });
  try {
    for (let n = 0; n < 64; n++) {
      const result = session.getExecutor(history).stream({ signal: controller.signal }, `turn-${n}`, []);
      streams.push(result.fullStream);
      assert.equal((await result.fullStream.next()).value.type, 'text-delta');
      assert.equal((await result.fullStream.next()).value.type, 'finish');
      await tick();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, `turn ${n}`);
      assert.equal(records, n + 1);
    }
  } finally { await Promise.all(streams.map(iterator => iterator.return())); }
  assert.equal(records, 64);
});

test('SSE bounds one pending frame, not the total size of a healthy stream', async () => {
  const body = new Response('data: 1234567890\n'.repeat(3) + '\n').body;
  await assert.rejects(Array.fromAsync(readSse(body, { maxEventChars: 32 })), /SSE event.*limit/i);
  assert.equal(body.locked, false);
  const many = new Response('data: abc\r\r'.repeat(50)).body;
  assert.deepEqual(await Array.fromAsync(readSse(many, { maxEventChars: 32 })), Array(50).fill('abc'));
});

test('SSE preserves multibyte UTF-8, split CRLF, comments and multiline data', async () => {
  const bytes = Buffer.from(': ping\r\nevent: fixture\r\ndata: {\r\ndata: "word": "\u6d41"}\r\n\r\ndata: trailing');
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  assert.deepEqual(await Array.fromAsync(readSse(body)), ['{\n"word": "\u6d41"}']);
  assert.equal(body.locked, false);
});

for (const format of API_FORMATS) {
  test(`${format}: a socket reset after visible text and buffered tool data is not replayed`, async t => {
    let socket;
    const text = format === 'openai' ? choice({ content: 'visible' }) : format === 'openai-responses'
      ? { type: 'response.output_text.delta', output_index: 1, delta: 'visible' }
      : { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'visible' } };
    const { baseUrl, requests } = await loopback(t, res => {
      socket = res.socket; res.write(frames([...toolEvents(format), text]));
    });
    const result = stream(format, baseUrl);
    assert.equal((await result.fullStream.next()).value.textDelta, 'visible');
    socket.destroy();
    await rejectedTurn(result, error => assert.ok(error instanceof Error));
    assert.equal(requests.length, 1);
  });
}

test('return while a body read is pending closes the upstream and rejects every slot', async t => {
  const sent = Promise.withResolvers(), closed = Promise.withResolvers();
  const { baseUrl, requests } = await loopback(t, res => {
    res.on('close', closed.resolve); res.write(': waiting\n\n'); sent.resolve();
  });
  const controller = new AbortController(), result = stream('openai', baseUrl, {}, controller.signal);
  const pending = assert.rejects(result.fullStream.next(), { name: 'AbortError' });
  await sent.promise;
  await result.fullStream.return();
  await pending;
  await closed.promise;
  for (const key of slots) await assert.rejects(result[key], { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(requests.length, 1);
});

test('caller cancellation while reading an HTTP 400 body wins over fallback', async t => {
  const sent = Promise.withResolvers();
  const { baseUrl, requests } = await loopback(t, res => {
    res.writeHead(400); res.write('{"error":'); sent.resolve();
  });
  const controller = new AbortController(), reason = new Error('caller stopped a pending rejection');
  const result = stream('openai', baseUrl, {}, controller.signal);
  const done = rejectedTurn(result, error => assert.equal(error, reason));
  await sent.promise;
  controller.abort(reason);
  await done;
  assert.equal(requests.length, 1);
});

test('upstream activity keeps a long turn alive beyond one idle interval', async t => {
  // Isolate the per-read deadline from the cost of the first real TCP request on emulated CPUs.
  // The separate stalled-header/body tests exercise real sockets and cancellation.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let wire, read = Promise.withResolvers();
  const body = new ReadableStream({ start(c) { wire = c; }, pull() { read.resolve(); } }, { highWaterMark: 0 });
  const result = stream('openai', 'http://127.0.0.1', { fetchImpl: () => new Response(body), idleTimeoutMs: 200 });
  t.after(() => result.fullStream.return());
  for (let n = 0; n < 8; n++) {
    const next = result.fullStream.next();
    await read.promise; read = Promise.withResolvers();
    t.mock.timers.tick(199);
    wire.enqueue(Buffer.from(frame(choice({ content: 'x' }))));
    assert.equal((await next).value.textDelta, 'x');
  }
  const end = result.fullStream.next();
  await read.promise;
  t.mock.timers.tick(199);
  wire.enqueue(Buffer.from(frames([choice({}, 'stop'), '[DONE]'])));
  assert.equal((await end).value.type, 'finish');
});

test('Responses argument completion fills a missing suffix without inventing empty arguments', async t => {
  const item = functionItem('only', 1);
  const { baseUrl } = await loopback(t, res => res.end(frames([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: item.arguments },
    completed({}),
  ])));
  const parts = await Array.fromAsync(stream('openai-responses', baseUrl).fullStream);
  assert.deepEqual(parts.filter(part => part.type === 'tool-call').map(part => part.args), [{ value: 1 }]);
});

test('Responses does not execute a streamed item that is missing from the final snapshot', async t => {
  const { baseUrl } = await loopback(t, res => res.end(frames([...toolEvents('openai-responses'), completed({ output: [] })])));
  await rejectedTurn(stream('openai-responses', baseUrl), /snapshot|output item/i);
});

test('Responses rejects conflicting item identities in the final snapshot', async t => {
  const { baseUrl } = await loopback(t, res => res.end(frames([...toolEvents('openai-responses'),
    completed({ output: [functionItem('different', 0)] })])));
  await rejectedTurn(stream('openai-responses', baseUrl), /conflict/i);
});

test('missing OpenAI function arguments become {} only for a tool that requires none', async t => {
  const required = [{ name: 'record', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }];
  for (const format of ['openai', 'openai-responses']) {
    const item = format === 'openai' ? choice({ tool_calls: [{ index: 0, id: 'missing', function: { name: 'record' } }] })
      : { type: 'response.output_item.done', output_index: 0, item: { ...functionItem('missing', 0), arguments: '' } };
    const { baseUrl } = await loopback(t, res => res.end(frames([item, ...ending(format)])));
    const strict = createModelSession({ model: 'fixture', apiFormat: format, baseUrl })
      .getExecutor(history).stream({}, 'fixture-turn', required);
    await rejectedTurn(strict, /tool arguments/i);
    const parts = await Array.fromAsync(stream(format, baseUrl).fullStream);
    assert.deepEqual(parts.filter(p => p.type === 'tool-call').map(p => p.args), [{}], format);
  }
});

test('Messages keeps complete initial tool input even without JSON deltas', async t => {
  const { baseUrl } = await loopback(t, res => res.end(frames([
    { type: 'message_start', message: { id: 'msg' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'record', input: { value: 7 } } },
    { type: 'content_block_stop', index: 0 }, ...ending('anthropic'),
  ])));
  const parts = await Array.fromAsync(stream('anthropic', baseUrl).fullStream);
  assert.deepEqual(parts.filter(part => part.type === 'tool-call').map(part => part.args), [{ value: 7 }]);
});

test('a model-specific fallback does not disable options for another selected model', async t => {
  const { baseUrl, requests } = await loopback(t, (res, n) => {
    if (n === 1) { res.writeHead(400); res.end(JSON.stringify({ error: { param: 'stream_options', message: 'Unsupported option' } })); }
    else res.end(frames([choice({ content: 'ok' }, 'stop'), '[DONE]']));
  });
  let model = 'first';
  const session = createModelSession({ baseUrl, model, selectRequest: () => ({ model }) });
  for (model of ['first', 'other', 'first']) await Array.fromAsync(session.getExecutor(history).stream({}, 'test', []).fullStream);
  assert.deepEqual(requests.map(r => [r.body.model, !!r.body.stream_options]),
    [['first', true], ['first', false], ['other', true], ['first', false]]);
});

test('a rejected output option does not discard valid replay or move a tool screenshot', async t => {
  const messages = [...history, { role: 'assistant', content: [
    { type: 'reasoning', text: 'fixture', signature: 'synthetic-item', providerOptions: { grokbot: { format: 'openai-responses', model: 'fixture' } } },
    { type: 'tool-call', toolCallId: 'old', toolName: 'record', args: { value: 1 } },
  ] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', result: 'fixture',
    experimental_content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }] }];
  const { baseUrl, requests } = await loopback(t, (res, n) => {
    const param = n === 1 ? 'reasoning.summary' : n === 2 ? 'max_output_tokens' : undefined;
    if (param) { res.writeHead(400); res.end(JSON.stringify({ error: { param, message: `Unsupported parameter: ${param}` } })); }
    else res.end(frame(completed({})));
  });
  const session = createModelSession({ baseUrl, model: 'fixture', apiFormat: 'openai-responses' });
  await Array.fromAsync(session.getExecutor(messages).stream({}, 'fixture', tools, { maxTokens: 200 }).fullStream);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body.input, requests[0].body.input);
  assert.deepEqual(requests[2].body.input, requests[0].body.input);
  assert.equal(requests[1].body.reasoning?.summary, undefined);
  assert.equal(requests[2].body.max_output_tokens, undefined);
});

test('a corrupt UTF-8 byte in tool arguments is not silently replaced and executed', async t => {
  const wire = Buffer.from(frames([choice({ tool_calls: [{ index: 0, id: 'one', function: { name: 'record', arguments: '{"value":"MARK"}' } }] }),
    ...ending('openai')]));
  wire[wire.indexOf('MARK')] = 0xff;
  const { baseUrl, requests } = await loopback(t, res => res.end(wire));
  await rejectedTurn(stream('openai', baseUrl), /UTF-8|utf-8/);
  assert.equal(requests.length, 1);
});
