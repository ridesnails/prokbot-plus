// Compatibility handlers for newer Desktop (1.2.3+) and iOS (1.26.0+/1.27.0+)
// gateway RPCs that clients forward to Host and that are not present in the
// pinned stable sand-host bundle (d0a4baa).
import { check } from './security.mjs';
import { validateAgentId } from './library.mjs';

export const clientCompatMethods = new Set([
  'searchConversation',
  'rerunAutomationFromCard',
  'runAutomationWebhook',
  'resolveSkillPublishTargets',
]);

function extractEntryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [];
  const push = value => {
    if (typeof value === 'string' && value.trim()) parts.push(value);
  };
  push(entry.text);
  push(entry.prompt);
  push(entry.content);
  if (entry.message && typeof entry.message === 'object') {
    push(entry.message.content);
    push(entry.message.text);
  }
  if (Array.isArray(entry.parts)) {
    for (const part of entry.parts) {
      if (typeof part === 'string') push(part);
      else if (part && typeof part === 'object') {
        push(part.text);
        push(part.content);
      }
    }
  }
  if (Array.isArray(entry.blocks)) {
    for (const block of entry.blocks) {
      if (block && typeof block === 'object') {
        push(block.text);
        push(block.content);
      }
    }
  }
  return parts.join('\n');
}

function buildSnippet(text, query) {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + needle.length + 100);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function entryRole(entry) {
  if (typeof entry?.role === 'string') return entry.role;
  if (entry?.kind === 'user' || entry?.type === 'user') return 'user';
  return 'assistant';
}

function automationListFrom(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.automations)) return result.automations;
  return [];
}

export async function handleClientCompatRpc(method, input, callHost) {
  if (method === 'resolveSkillPublishTargets') return { targets: [] };

  if (method === 'rerunAutomationFromCard') {
    const id = validateAgentId(input?.id);
    check(typeof input?.automationId === 'string' && input.automationId.trim().length > 0, 400, '缺少自动化 ID');
    const automationId = input.automationId.trim();
    const list = automationListFrom(await callHost('getAgentAutomations', { id }));
    const exists = list.some(item => item && (item.id === automationId || item.automationId === automationId));
    if (!exists) {
      return { ok: false, result: 'not_offered', id, automationId };
    }
    await callHost('runAgentAutomationNow', { id, automationId });
    return { ok: true, result: 'started', id, automationId };
  }

  if (method === 'runAutomationWebhook') {
    validateAgentId(input?.id);
    check(typeof input?.automationId === 'string' && input.automationId.trim().length > 0, 400, '缺少自动化 ID');
    // Pinned sand-host (d0a4baa) does not expose webhook payload/context forwarding
    // or a real runId; fail closed with HTTP 501 so clients report failure instead
    // of treating any 2xx response as landed.
    check(false, 501, '此自部署 Host 暂不支持自动化 Webhook 触发');
  }

  if (method === 'searchConversation') {
    const agentId = validateAgentId(input?.agentId);
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 200);
    if (!query) return { matches: [], isComplete: true };
    const maxPages = 20;
    const pageLimit = 200;
    const matches = [];
    const seen = new Set();
    let beforeSeq = typeof input?.beforeSeq === 'number' && Number.isFinite(input.beforeSeq)
      ? input.beforeSeq
      : undefined;
    let reachedEnd = false;
    let nextCursor = undefined;

    for (let pageIndex = 0; pageIndex < maxPages && matches.length < limit; pageIndex++) {
      const args = {
        id: agentId,
        limit: pageLimit,
        ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
      };
      // Propagate Host errors (404/503/etc.) rather than reporting an empty complete search.
      const page = await callHost('getAgentTranscriptWindow', args);
      const entries = Array.isArray(page?.entries) ? page.entries : [];
      const pageNextBeforeSeq =
        typeof page?.nextBeforeSeq === 'number' && Number.isFinite(page.nextBeforeSeq)
          ? page.nextBeforeSeq
          : undefined;
      const hasMore =
        pageNextBeforeSeq !== undefined &&
        pageNextBeforeSeq !== beforeSeq &&
        entries.length > 0;

      // Scan the entire fetched page rather than stopping mid-page: official transcript
      // entries come from parseTranscriptEntry(row.entry) and do not include `seq`, so
      // continuation can only resume cleanly at `page.nextBeforeSeq`.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const entryId = String(entry?.id ?? '');
        if (entryId && seen.has(entryId)) continue;
        const text = extractEntryText(entry);
        if (!text) continue;
        const snippet = buildSnippet(text, query);
        if (snippet === null) continue;
        if (entryId) seen.add(entryId);
        matches.push({
          entryId,
          role: entryRole(entry),
          timestampMs: Number(entry.timestampMs ?? entry.createdAtMs ?? 0) || 0,
          snippet,
        });
      }

      if (!hasMore) {
        reachedEnd = true;
        nextCursor = undefined;
        break;
      }
      beforeSeq = pageNextBeforeSeq;
      nextCursor = pageNextBeforeSeq;
    }

    return {
      matches,
      isComplete: reachedEnd,
      ...(!reachedEnd && nextCursor !== undefined ? { nextBeforeSeq: nextCursor } : {}),
    };
  }

  check(false, 404, '兼容接口不存在');
}
