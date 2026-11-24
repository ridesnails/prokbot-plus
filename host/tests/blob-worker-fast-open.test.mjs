import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_BLOB_QUICK_CHECK_MAX_BYTES,
  blobQuickCheckMaxBytes,
  quickCheckRequiredMarkerPath,
  quickCheckVerifiedMarkerPath,
  wrapOpenConversationBlobDb,
} from '../runtime/recovered-blob-worker.mjs';
import { constructRecoveredModules } from '../runtime/recovered-modules.mjs';
import { DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS, proxyHttp } from '../server/proxy.mjs';

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return readFileSync(filePath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test('blobQuickCheckMaxBytes parses defaults, overrides, and infinity', () => {
  assert.equal(blobQuickCheckMaxBytes({}), DEFAULT_BLOB_QUICK_CHECK_MAX_BYTES);
  assert.equal(blobQuickCheckMaxBytes({ GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES: '67108864' }), 67108864);
  assert.equal(blobQuickCheckMaxBytes({ GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES: '0' }), 0);
  assert.equal(blobQuickCheckMaxBytes({ GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES: 'infinity' }), Number.POSITIVE_INFINITY);
  assert.equal(blobQuickCheckMaxBytes({ GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES: 'invalid' }), DEFAULT_BLOB_QUICK_CHECK_MAX_BYTES);
});

test('wrapOpenConversationBlobDb delegates small, missing, infinity, and pending-recovery DBs to original', () => {
  let originalCalls = 0;
  const originalOpen = opts => ({ kind: 'original', call: ++originalCalls, path: opts.dbPath });
  const files = new Map();
  const io = {
    exists: p => files.has(p),
    readText: p => files.get(p),
    writeText: (p, v) => files.set(p, v),
    unlink: p => files.delete(p),
    scheduleBackgroundCheck: () => { throw new Error('should not schedule'); },
  };
  const bindings = {
    DISK_RECOVERY: { tag: 'disk' },
    findPendingRecovery: () => undefined,
    openConfiguredConversationBlobDb: () => { throw new Error('should not run fast path'); },
  };

  const smallOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
    ...io,
    maxQuickCheckBytes: 1000,
    stat: () => ({ size: 999, mtimeMs: 100 }),
  });
  assert.equal(smallOpen({ dbPath: '/tmp/a.db', busyTimeoutMs: 5000 }).kind, 'original');
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/tmp/a.db')), false);

  const boundaryOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
    ...io,
    maxQuickCheckBytes: 1000,
    stat: () => ({ size: 1000, mtimeMs: 100 }),
  });
  assert.equal(boundaryOpen({ dbPath: '/tmp/boundary.db', busyTimeoutMs: 5000 }).kind, 'original');
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/tmp/boundary.db')), false);

  const missingOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
    ...io,
    maxQuickCheckBytes: 1000,
    stat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(missingOpen({ dbPath: '/tmp/missing.db', busyTimeoutMs: 5000 }).kind, 'original');

  const forcedQuickCheckOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
    ...io,
    maxQuickCheckBytes: Number.POSITIVE_INFINITY,
    stat: () => ({ size: 2_000_000_000, mtimeMs: 200 }),
  });
  assert.equal(forcedQuickCheckOpen({ dbPath: '/tmp/huge.db', busyTimeoutMs: 5000 }).kind, 'original');
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/tmp/huge.db')), false);

  const pendingOpen = wrapOpenConversationBlobDb(originalOpen, {
    ...bindings,
    findPendingRecovery: () => ({ pendingPath: '/tmp/huge.db.pending', quarantinePath: '/tmp/huge.db.corrupt' }),
  }, {
    ...io,
    maxQuickCheckBytes: 1000,
    stat: () => ({ size: 2_000_000_000, mtimeMs: 200 }),
  });
  assert.equal(pendingOpen({ dbPath: '/tmp/huge.db', busyTimeoutMs: 5000 }).kind, 'original');
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/tmp/huge.db')), true);
  assert.equal(originalCalls, 5);
});

test('real worker thread runs node:sqlite PRAGMA quick_check(1) for healthy and corrupted DBs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-blob-worker-real-'));
  let healthyHandle = null;
  let corruptHandle = null;
  try {
    const healthyPath = join(dir, 'healthy-blobs.db');
    const seed = new DatabaseSync(healthyPath);
    seed.exec('PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
    const insert = seed.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
    for (let i = 0; i < 40; i++) {
      insert.run(`blob-${String(i).padStart(3, '0')}`, Buffer.alloc(4096, (i % 251) + 1));
    }
    seed.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    seed.close();

    const corruptPath = join(dir, 'corrupt-blobs.db');
    await copyFile(healthyPath, corruptPath);
    // Corrupt a later B-tree/overflow page so the O(1) structural probe (schema_version + LIMIT 1)
    // passes on fast-open while background PRAGMA quick_check(1) detects corruption.
    const corruptBytes = readFileSync(corruptPath);
    const corruptOffset = Math.max(4096 * 4, corruptBytes.length - 8192);
    corruptBytes.fill(0xff, corruptOffset, Math.min(corruptBytes.length, corruptOffset + 4096));
    writeFileSync(corruptPath, corruptBytes);

    let originalCalls = 0;
    const originalOpen = opts => ({ kind: 'original-recovery', call: ++originalCalls, path: opts.dbPath });
    const bindings = {
      DISK_RECOVERY: { tag: 'disk' },
      findPendingRecovery: () => undefined,
      openConfiguredConversationBlobDb: (dbPath, busyTimeoutMs = 5000) => {
        const db = new DatabaseSync(dbPath);
        db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        return db;
      },
    };

    const fastOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
      maxQuickCheckBytes: 1024,
      backgroundDelayMs: 0,
    });

    // 1) Healthy WAL DB: real background worker verifies it even under concurrent writes.
    const initialStat = statSync(healthyPath);
    healthyHandle = fastOpen({ dbPath: healthyPath, busyTimeoutMs: 5000 });
    assert.ok(healthyHandle instanceof DatabaseSync);
    const writeStmt = healthyHandle.prepare('INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)');
    for (let i = 0; i < 10; i++) {
      writeStmt.run(`live-${i}`, Buffer.alloc(512, i + 1));
    }
    const verifiedRaw = await waitForFile(quickCheckVerifiedMarkerPath(healthyPath));
    const verified = JSON.parse(verifiedRaw);
    assert.equal(verified.path, healthyPath);
    assert.equal(verified.size, initialStat.size);
    assert.equal(verified.mtimeMs, initialStat.mtimeMs);
    assert.equal(existsSync(quickCheckRequiredMarkerPath(healthyPath)), false);
    healthyHandle.close();
    healthyHandle = null;

    // 2) Corrupted DB: fast-open succeeds on structural probe, real background worker writes .quickcheck-required.
    corruptHandle = fastOpen({ dbPath: corruptPath, busyTimeoutMs: 5000 });
    assert.ok(corruptHandle instanceof DatabaseSync);
    const requiredRaw = await waitForFile(quickCheckRequiredMarkerPath(corruptPath));
    const required = JSON.parse(requiredRaw);
    assert.equal(required.path, corruptPath);
    assert.ok(typeof required.reason === 'string' && required.reason.length > 0);
    assert.equal(existsSync(quickCheckVerifiedMarkerPath(corruptPath)), false);
    corruptHandle.close();
    corruptHandle = null;

    // Next open sees .quickcheck-required and delegates to stock originalOpen for quarantine/salvage.
    const recovered = fastOpen({ dbPath: corruptPath, busyTimeoutMs: 5000 });
    assert.equal(recovered.kind, 'original-recovery');
    assert.equal(originalCalls, 1);
    assert.equal(existsSync(quickCheckRequiredMarkerPath(corruptPath)), false);

    // 3) Small DB (<= maxQuickCheckBytes) uses originalOpen and never writes a verified stamp.
    const smallPath = join(dir, 'small-blobs.db');
    const smallSeed = new DatabaseSync(smallPath);
    smallSeed.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
    smallSeed.close();
    const smallOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
      maxQuickCheckBytes: statSync(smallPath).size,
      backgroundDelayMs: 0,
    });
    assert.equal(smallOpen({ dbPath: smallPath, busyTimeoutMs: 5000 }).kind, 'original-recovery');
    assert.equal(existsSync(quickCheckVerifiedMarkerPath(smallPath)), false);
    assert.equal(existsSync(quickCheckRequiredMarkerPath(smallPath)), false);
  } finally {
    try { healthyHandle?.close(); } catch {}
    try { corruptHandle?.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('compose files forward GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES to Host container', () => {
  for (const name of ['compose.yaml', 'compose.host.yaml']) {
    const text = readFileSync(new URL(`../release/${name}`, import.meta.url), 'utf8');
    assert.match(text, /GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES:\s*\$\{GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES:-\}/);
  }
});

test('wrapOpenConversationBlobDb schedules background quick_check, records verified marker, and triggers full recovery on corruption', () => {
  const queries = [];
  let closed = false;
  const fakeDb = {
    prepare(sql) {
      queries.push(sql);
      return { get: () => ({ ok: 1 }) };
    },
    close() { closed = true; },
  };
  let originalCalls = 0;
  const originalOpen = () => ({ kind: 'original', call: ++originalCalls });
  const files = new Map();
  const scheduled = [];
  const io = {
    exists: p => files.has(p),
    readText: p => files.get(p),
    writeText: (p, v) => files.set(p, v),
    unlink: p => files.delete(p),
    scheduleBackgroundCheck: job => scheduled.push(job),
  };
  const bindings = {
    DISK_RECOVERY: { tag: 'disk' },
    findPendingRecovery: () => undefined,
    openConfiguredConversationBlobDb: (dbPath, busyTimeoutMs) => {
      assert.equal(dbPath, '/data/conversation-blobs.db');
      assert.equal(busyTimeoutMs, 5000);
      return fakeDb;
    },
  };

  let currentStat = { size: 2_000_000_000, mtimeMs: 1000 };
  const fastOpen = wrapOpenConversationBlobDb(originalOpen, bindings, {
    ...io,
    maxQuickCheckBytes: 1024,
    stat: () => currentStat,
  });

  // First open uses fast path and schedules one background quick_check.
  const opened = fastOpen({ dbPath: '/data/conversation-blobs.db', busyTimeoutMs: 5000 });
  assert.equal(opened, fakeDb);
  assert.equal(originalCalls, 0);
  assert.equal(closed, false);
  assert.deepEqual(queries, ['PRAGMA schema_version', 'SELECT id FROM blobs LIMIT 1']);
  assert.equal(scheduled.length, 1);

  // When background quick_check passes, verified marker prevents redundant rescan for same size+mtimeMs.
  scheduled[0].onOutcome({ status: 'ok' });
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/data/conversation-blobs.db')), true);
  assert.equal(fastOpen({ dbPath: '/data/conversation-blobs.db', busyTimeoutMs: 5000 }), fakeDb);
  assert.equal(scheduled.length, 1);

  // When the file changes and background quick_check detects corruption, it writes the recovery marker.
  currentStat = { size: 2_000_004_096, mtimeMs: 2000 };
  assert.equal(fastOpen({ dbPath: '/data/conversation-blobs.db', busyTimeoutMs: 5000 }), fakeDb);
  assert.equal(scheduled.length, 2);
  scheduled[1].onOutcome({ status: 'corrupt', reason: 'malformed page 42' });
  assert.equal(files.has(quickCheckRequiredMarkerPath('/data/conversation-blobs.db')), true);
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/data/conversation-blobs.db')), false);

  // Next open delegates to stock originalOpen for quarantine/salvage and clears the required marker.
  const recovered = fastOpen({ dbPath: '/data/conversation-blobs.db', busyTimeoutMs: 5000 });
  assert.equal(recovered.kind, 'original');
  assert.equal(originalCalls, 1);
  assert.equal(files.has(quickCheckRequiredMarkerPath('/data/conversation-blobs.db')), false);
  assert.equal(files.has(quickCheckVerifiedMarkerPath('/data/conversation-blobs.db')), true);

  // Structural probe failure falls back immediately to originalOpen.
  const corruptFastOpen = wrapOpenConversationBlobDb(originalOpen, {
    ...bindings,
    openConfiguredConversationBlobDb: () => ({
      prepare(sql) {
        if (sql.includes('blobs')) throw new Error('SQLITE_CORRUPT');
        return { get: () => ({ schema_version: 1 }) };
      },
      close() { closed = true; },
    }),
  }, {
    ...io,
    maxQuickCheckBytes: 1024,
    stat: () => ({ size: 2_000_000_000, mtimeMs: 3000 }),
  });
  const fallback = corruptFastOpen({ dbPath: '/data/conversation-blobs.db', busyTimeoutMs: 5000 });
  assert.equal(fallback.kind, 'original');
  assert.equal(originalCalls, 2);
  assert.equal(closed, true);
});

test('constructRecoveredModules delivers overridden exports to downstream modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-recovered-override-'));
  try {
    await writeFile(join(dir, 'base.mjs'), `
      export function createRecoveredModule() {
        return {
          openDb: (name) => 'original:' + name,
          helper: () => 'helped',
        };
      }
    `);
    await writeFile(join(dir, 'consumer.mjs'), `
      export function createRecoveredModule({ openDb }) {
        return {
          useDb: (name) => openDb(name),
        };
      }
    `);
    const plan = {
      modules: [
        { name: 'base.mjs', dependencies: [], recoveredDependencies: [], originalDependencies: [], exports: ['openDb', 'helper'] },
        { name: 'consumer.mjs', dependencies: ['openDb'], recoveredDependencies: ['openDb'], originalDependencies: [], exports: ['useDb'] },
      ],
    };
    const constructed = await constructRecoveredModules(plan, {}, dir, 'Test', {
      overrides: {
        openDb: (orig, bindings) => (name) => `wrapped:${bindings.helper()}:${orig(name)}`,
      },
    });
    assert.equal(constructed.bindings.useDb('blobs'), 'wrapped:helped:original:blobs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('proxyHttp defaults to 120s upstream headers timeout and enforces custom headersTimeoutMs', async () => {
  assert.equal(DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS, 120_000);
  const upstream = http.createServer((req, res) => {
    const delay = req.url === '/slow' ? 200 : 10;
    const timer = setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    }, delay);
    req.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const target = new URL(`http://127.0.0.1:${upstream.address().port}/`);
  const proxy = http.createServer((req, res) => {
    proxyHttp(req, res, { target, path: req.url, headersTimeoutMs: 60 });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const fast = await fetch(`http://127.0.0.1:${proxy.address().port}/fast`);
    assert.equal(fast.status, 200);
    assert.deepEqual(await fast.json(), { ok: true });

    const slow = await fetch(`http://127.0.0.1:${proxy.address().port}/slow`);
    assert.equal(slow.status, 502);
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});
