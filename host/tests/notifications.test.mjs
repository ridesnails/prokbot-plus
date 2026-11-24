import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { Notifications } from '../server/notifications.mjs';

test('Notifications SSE subscribe handles >256KB retained history without destroying the stream', async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/grokbot-notif-`);
  const notifications = await new Notifications(dir, { retain: 1000 }).load();
  // Seed 600 items (~600KB) exceeding the 256KB live writableLength threshold.
  const body = 'A'.repeat(900);
  const items = [];
  for (let i = 0; i < 600; i++) {
    items.push({
      id: `n-${i}`,
      type: 'message',
      agentId: 'agent-1',
      title: `Title ${i}`,
      body,
      createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      deepLink: 'grokbot-local://agent/agent-1',
    });
  }
  await notifications.store.mutate((state) => { state.items = items; });

  const server = http.createServer((req, res) => notifications.subscribe(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Fresh connect without Last-Event-ID receives bounded tail + : connected cleanly.
    const text = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/notifications/events' }, (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes(': connected\n\n')) {
            req.destroy();
            resolve(buf);
          }
        });
        res.on('error', reject);
      });
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    assert.ok(text.includes('id: n-599\n'), 'should include latest notification');
    assert.ok(!text.includes('id: n-0\n'), 'should cap initial un-cursored replay');
    assert.ok(text.includes(': connected\n\n'), 'should finish replay with connected marker');

    // 2. Cursor-based reconnect replays exact missed events even when >256KB.
    const cursorText = await new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/notifications/events', headers: { 'Last-Event-ID': 'n-200' } },
        (res) => {
          assert.equal(res.statusCode, 200);
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            if (buf.includes(': connected\n\n')) {
              req.destroy();
              resolve(buf);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
    assert.ok(cursorText.includes('id: n-201\n'));
    assert.ok(cursorText.includes('id: n-599\n'));
    assert.ok(cursorText.includes(': connected\n\n'));
  } finally {
    notifications.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Notifications SSE subscribe catches up notifications published while backpressured on drain', async () => {
  const { EventEmitter } = await import('node:events');
  const dir = await mkdtemp(`${os.tmpdir()}/grokbot-notif-drain-`);
  const notifications = await new Notifications(dir, { retain: 100 }).load();
  await notifications.publish({ id: 'n-1', type: 'message', agentId: 'agent-1', title: 'First', body: 'first' });
  await notifications.publish({ id: 'n-2', type: 'message', agentId: 'agent-1', title: 'Second', body: 'second' });

  class FakeResponse extends EventEmitter {
    constructor() {
      super();
      this.chunks = [];
      this.destroyed = false;
      this.writableEnded = false;
      this.writableLength = 0;
      this.pauseOnce = true;
    }
    writeHead() {}
    flushHeaders() {}
    write(chunk) {
      this.chunks.push(chunk);
      if (this.pauseOnce) {
        this.pauseOnce = false;
        return false;
      }
      return true;
    }
    destroy() {
      this.destroyed = true;
      this.emit('close');
    }
  }

  try {
    const res = new FakeResponse();
    notifications.subscribe({ headers: {} }, res);
    // Subscriber is now paused waiting for 'drain' after writing n-1.
    assert.equal(notifications.clients.has(res), false);
    assert.equal(notifications.pending.has(res), true);

    // Publish n-3 while the subscriber is mid-backlog drain.
    await notifications.publish({ id: 'n-3', type: 'message', agentId: 'agent-1', title: 'During drain', body: 'live' });

    // Resume draining: n-2 AND n-3 must be delivered before : connected, with no duplicates.
    res.emit('drain');
    assert.equal(notifications.clients.has(res), true);
    assert.equal(notifications.pending.has(res), false);

    // Publish n-4 after live promotion.
    await notifications.publish({ id: 'n-4', type: 'message', agentId: 'agent-1', title: 'After live', body: 'after' });

    const output = res.chunks.join('');
    const ids = [...output.matchAll(/^id: (n-\d+)$/gm)].map((m) => m[1]);
    assert.deepEqual(ids, ['n-1', 'n-2', 'n-3', 'n-4']);
    assert.ok(output.indexOf('id: n-3\n') < output.indexOf(': connected\n\n'));
    assert.ok(output.indexOf(': connected\n\n') < output.indexOf('id: n-4\n'));
  } finally {
    notifications.close();
    await rm(dir, { recursive: true, force: true });
  }
});
