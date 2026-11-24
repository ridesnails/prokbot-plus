import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, isMainThread, threadId } from 'node:worker_threads';
import { constructRecoveredModules } from './recovered-modules.mjs';
import inputs from '../recipes/host/manifest.json' with { type: 'json' };

const sourceSha256 = inputs.sourceSha256['agent-isolation/agent-store-worker.cjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const DEFAULT_BLOB_QUICK_CHECK_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_BACKGROUND_CHECK_DELAY_MS = 2_000;
const activeBackgroundChecks = new Set();

export function quickCheckRequiredMarkerPath(dbPath) {
  return `${dbPath}.quickcheck-required`;
}

export function quickCheckVerifiedMarkerPath(dbPath) {
  return `${dbPath}.quickcheck-verified.json`;
}

export function blobQuickCheckMaxBytes(env = process.env) {
  const raw = env?.GROKBOT_BLOB_DB_QUICK_CHECK_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_BLOB_QUICK_CHECK_MAX_BYTES;
  if (raw.toLowerCase() === 'infinity') return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BLOB_QUICK_CHECK_MAX_BYTES;
}

function isVerifiedForStat(dbPath, statInfo, { exists, readText }) {
  const markerPath = quickCheckVerifiedMarkerPath(dbPath);
  if (!exists(markerPath)) return false;
  try {
    const parsed = JSON.parse(readText(markerPath));
    return (
      parsed?.path === dbPath &&
      parsed?.size === statInfo.size &&
      parsed?.mtimeMs === statInfo.mtimeMs
    );
  } catch {
    return false;
  }
}

function recordVerified(dbPath, statInfo, { writeText, unlink }) {
  try { unlink(quickCheckRequiredMarkerPath(dbPath)); } catch {}
  try {
    writeText(
      quickCheckVerifiedMarkerPath(dbPath),
      JSON.stringify({
        path: dbPath,
        size: statInfo.size,
        mtimeMs: statInfo.mtimeMs,
        checkedAt: Date.now(),
      }),
    );
  } catch {}
}

function recordCorruption(dbPath, reason, { writeText, unlink }) {
  try { unlink(quickCheckVerifiedMarkerPath(dbPath)); } catch {}
  try {
    writeText(
      quickCheckRequiredMarkerPath(dbPath),
      JSON.stringify({
        path: dbPath,
        reason: String(reason || 'quick_check failed'),
        detectedAt: Date.now(),
      }),
    );
  } catch {}
}

const BACKGROUND_QUICK_CHECK_WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { dbPath, busyTimeoutMs } = workerData;
let db;
try {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    parentPort.postMessage({ status: 'skipped', reason: 'node:sqlite unavailable' });
    process.exit(0);
  }
  const timeout = Number.isFinite(busyTimeoutMs) && busyTimeoutMs >= 0 ? Math.trunc(busyTimeoutMs) : 5000;
  db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(\`PRAGMA busy_timeout = \${timeout}\`);
  const row = db.prepare('PRAGMA quick_check(1)').get();
  const value = row ? Object.values(row)[0] : null;
  if (value === 'ok') {
    parentPort.postMessage({ status: 'ok' });
  } else {
    parentPort.postMessage({ status: 'corrupt', reason: String(value ?? 'unexpected quick_check result') });
  }
} catch (error) {
  const code = String(error?.code ?? '');
  const errstr = String(error?.errstr ?? '');
  const errcode = Number.isInteger(error?.errcode) ? (error.errcode & 0xff) : -1;
  const message = String(error?.message ?? error);
  if (
    errcode === 5 || errcode === 6 ||
    code.includes('BUSY') || code.includes('LOCKED') ||
    /database is locked|database table is locked|busy/i.test(message) ||
    /locked|busy/i.test(errstr)
  ) {
    parentPort.postMessage({ status: 'busy', reason: message });
  } else if (
    errcode === 11 || errcode === 26 ||
    code.includes('CORRUPT') || code.includes('NOTADB') ||
    /malformed|corrupt|not a database/i.test(message) ||
    /malformed|corrupt|not a database/i.test(errstr)
  ) {
    parentPort.postMessage({ status: 'corrupt', reason: message });
  } else {
    parentPort.postMessage({ status: 'error', reason: message });
  }
} finally {
  try { db?.close(); } catch {}
}
`;

export function defaultScheduleBackgroundQuickCheck({
  dbPath,
  statInfo,
  busyTimeoutMs = 5000,
  delayMs = DEFAULT_BACKGROUND_CHECK_DELAY_MS,
  onOutcome,
}) {
  if (activeBackgroundChecks.has(dbPath)) return;
  activeBackgroundChecks.add(dbPath);
  const timer = setTimeout(() => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      activeBackgroundChecks.delete(dbPath);
      onOutcome?.(outcome);
    };
    try {
      const worker = new Worker(BACKGROUND_QUICK_CHECK_WORKER_SOURCE, {
        eval: true,
        workerData: { dbPath, busyTimeoutMs },
      });
      worker.unref();
      worker.once('message', message => {
        finish(message);
        void worker.terminate().catch(() => {});
      });
      worker.once('error', error => {
        finish({ status: 'error', reason: error?.message ?? String(error) });
      });
      worker.once('exit', () => {
        finish({ status: 'skipped', reason: 'worker exited' });
      });
    } catch (error) {
      finish({ status: 'error', reason: error?.message ?? String(error) });
    }
  }, delayMs);
  timer.unref?.();
}

/** Avoid blocking worker init for 60s+ on PRAGMA quick_check for multi-hundred-MB blob DBs. */
export function wrapOpenConversationBlobDb(
  originalOpen,
  bindings,
  {
    maxQuickCheckBytes = blobQuickCheckMaxBytes(),
    stat = statSync,
    exists = existsSync,
    readText = path => readFileSync(path, 'utf8'),
    writeText = (path, content) => writeFileSync(path, content, 'utf8'),
    unlink = unlinkSync,
    backgroundDelayMs = DEFAULT_BACKGROUND_CHECK_DELAY_MS,
    scheduleBackgroundCheck = defaultScheduleBackgroundQuickCheck,
  } = {},
) {
  const io = { exists, readText, writeText, unlink };
  const finishOriginalOpen = (dbPath, allowStamp) => {
    try {
      if (exists(quickCheckRequiredMarkerPath(dbPath))) {
        unlink(quickCheckRequiredMarkerPath(dbPath));
      }
    } catch {}
    if (!allowStamp) return;
    try {
      const afterStat = stat(dbPath);
      if (afterStat.size > maxQuickCheckBytes) {
        recordVerified(dbPath, afterStat, io);
      } else if (exists(quickCheckVerifiedMarkerPath(dbPath))) {
        unlink(quickCheckVerifiedMarkerPath(dbPath));
      }
    } catch {}
  };
  return function openConversationBlobDbWithLargeDbFastPath(options) {
    if (!options?.dbPath || maxQuickCheckBytes === Number.POSITIVE_INFINITY) {
      const db = originalOpen(options);
      if (options?.dbPath) finishOriginalOpen(options.dbPath, false);
      return db;
    }
    let statInfo;
    try {
      statInfo = stat(options.dbPath);
    } catch {
      return originalOpen(options);
    }
    if (statInfo.size <= maxQuickCheckBytes) {
      const db = originalOpen(options);
      finishOriginalOpen(options.dbPath, false);
      return db;
    }
    const recovery = options.recovery ?? bindings.DISK_RECOVERY;
    if (
      bindings.findPendingRecovery(options.dbPath, recovery) != null ||
      exists(quickCheckRequiredMarkerPath(options.dbPath))
    ) {
      const db = originalOpen(options);
      finishOriginalOpen(options.dbPath, true);
      return db;
    }
    let db;
    try {
      db = bindings.openConfiguredConversationBlobDb(options.dbPath, options.busyTimeoutMs);
      db.prepare('PRAGMA schema_version').get();
      db.prepare('SELECT id FROM blobs LIMIT 1').get();
    } catch {
      try { db?.close(); } catch {}
      const recovered = originalOpen(options);
      finishOriginalOpen(options.dbPath, true);
      return recovered;
    }
    if (!isVerifiedForStat(options.dbPath, statInfo, io)) {
      scheduleBackgroundCheck({
        dbPath: options.dbPath,
        statInfo,
        busyTimeoutMs: options.busyTimeoutMs ?? 5000,
        delayMs: backgroundDelayMs,
        onOutcome: outcome => {
          if (outcome?.status === 'ok') {
            recordVerified(options.dbPath, statInfo, io);
          } else if (outcome?.status === 'corrupt') {
            recordCorruption(options.dbPath, outcome.reason, io);
            console.error(
              '[recovered-blob-worker] background quick_check failed; full recovery scheduled on next open: ' +
                JSON.stringify({ dbPath: options.dbPath, reason: outcome.reason }),
            );
          }
        },
      });
    }
    return db;
  };
}

export async function describeRecoveredBlobWorker(state) {
  const provenance = JSON.parse(await readFile(join(state, 'blob-worker-library-provenance.json'), 'utf8'));
  const prepared = await readFile(join(state, 'blob-worker-library.cjs'));
  const entryPath = join(state, 'recovered-worker/agent-isolation/agent-store-worker.cjs');
  if (provenance.sourceSha256 !== sourceSha256 || hash(prepared) !== provenance.sha256 ||
      hash(await readFile(entryPath)) !== provenance.entrySha256) throw new Error('Prepared blob worker provenance mismatch');
  const directory = join(state, 'recovered-core/stable');
  const manifest = JSON.parse(await readFile(join(directory, 'blob-worker-provenance.json'), 'utf8'));
  if (manifest.sourceSha256 !== sourceSha256) throw new Error('Worker modules source mismatch');
  const modules = [];
  for (const module of manifest.modules) {
    if (!/^blob-worker-[\w-]+\.mjs$/.test(module.name)) throw new Error('Invalid worker module name');
    const sha256 = hash(await readFile(join(directory, module.name)));
    modules.push({ file: module.name, sha256, generatedSha256: module.sha256, modified: sha256 !== module.sha256 });
  }
  return { configured: true, sourceSha256, preparedSha256: provenance.sha256, entryPath,
    entrySha256: provenance.entrySha256, moduleBytesSha256: hash(JSON.stringify(modules)),
    bindings: provenance.bindings, sharedBindings: provenance.sharedBindings, modules };
}

export async function loadRecoveredBlobWorker(state) {
  const status = await describeRecoveredBlobWorker(state);
  const library = createRequire(import.meta.url)(join(state, 'blob-worker-library.cjs'));
  const constructed = await constructRecoveredModules(
    library.blobWorkerRecoveryPlan,
    library.getBlobWorkerRecoveryBindings(),
    join(state, 'recovered-core/stable'),
    'Blob worker',
    {
      overrides: {
        openConversationBlobDb: (originalOpen, bindings) => wrapOpenConversationBlobDb(originalOpen, bindings),
      },
    },
  );
  library.installRecoveredBlobWorker(constructed.bindings);
  return { library, status: { ...status, installed: true } };
}

export async function startRecoveredBlobWorker(state) {
  if (isMainThread) throw new Error('Recovered blob worker must run in a worker thread');
  const { library, status } = await loadRecoveredBlobWorker(state);
  console.error('[recovered-blob-worker] installed ' + JSON.stringify({ pid: process.pid, threadId,
    preparedSha256: status.preparedSha256, moduleBytesSha256: status.moduleBytesSha256,
    moduleCount: status.modules.length, callableCount: status.bindings.length,
    modifiedModules: status.modules.filter(module => module.modified).map(module => module.file) }));
  library.getBlobWorkerRecoveryBindings().main();
}
