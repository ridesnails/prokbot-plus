// Shared pieces of the three model API formats: errors, SSE, media, reasoning
// provenance and optional-parameter fallback.
import { recordToolCallOrder } from './reliability/tool-order.mjs';

export class ModelRequestError extends Error {
  constructor(message, { status, code, retryAfterMs, cause, param } = {}) {
    super(message, { cause });
    this.name = 'ModelRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.param = param;
  }
}

export function retryAfterMs(headers) {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  // HTTP-date is the other Retry-After form; reject numeric-looking invalid values.
  if (!/[a-z]/i.test(value)) return undefined;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : undefined;
}

/** Build a ModelRequestError from an OpenAI- or Anthropic-style error payload. */
export function providerError(payload, status, headers, apiKey) {
  const error = payload?.error ?? payload?.response?.error ?? payload;
  let message = typeof error?.message === 'string' ? error.message : `Model request failed${status ? ` (HTTP ${status})` : ''}`;
  // Redact echoed credentials; very short values would only corrupt the message.
  if (apiKey && apiKey.length >= 8) message = message.split(apiKey).join('[redacted]');
  const reportedStatus = error?.status ?? error?.status_code;
  const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code
    : typeof error?.type === 'string' && error.type !== 'error' ? error.type : undefined;
  return new ModelRequestError(message, {
    status: status ?? (Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599 ? reportedStatus : undefined),
    code, param: typeof error?.param === 'string' ? error.param : undefined, retryAfterMs: retryAfterMs(headers),
  });
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export async function errorFromResponse(http, apiKey) {
  if (!http.body) return providerError(undefined, http.status, http.headers, apiKey);
  const reader = http.body.getReader();
  let bytes, size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_ERROR_BODY_BYTES - size) {
        await reader.cancel().catch(() => {});
        return new ModelRequestError(`Model request failed (HTTP ${http.status}); error body exceeds 64 KiB`,
          { status: http.status, retryAfterMs: retryAfterMs(http.headers) });
      }
      // One bounded buffer also handles arbitrarily fragmented or compressed error responses.
      if (value.byteLength) {
        bytes ??= Buffer.allocUnsafe(MAX_ERROR_BODY_BYTES);
        bytes.set(value, size);
        size += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  let payload;
  if (size) {
    try { payload = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return providerError(payload, http.status, http.headers, apiKey);
}

const direct = action => action();
const MAX_EVENT_CHARS = 16 * 1024 * 1024;

/** SSE events can cross UTF-8 chunks and use LF, CRLF, or CR line endings. */
export async function* readSse(body, { waitForIO = direct, maxEventChars = MAX_EVENT_CHARS } = {}) {
  if (!body) throw new ModelRequestError('Model response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', skipLF = false, data = [], buffered = 0;
  function accept(line) {
    if (line === '') {
      const event = data.length ? data.join('\n') : undefined;
      data = []; buffered = 0;
      return event;
    }
    if (line === 'data' || line.startsWith('data:')) {
      if (buffered + line.length + 1 > maxEventChars) throw new ModelRequestError('Model SSE event exceeds size limit');
      data.push(line.slice(line[5] === ' ' ? 6 : 5));
      buffered += line.length + 1;
    }
    return undefined;
  }
  // Some compatible gateways omit blank lines between data frames. Parse glued
  // JSON incrementally so a large event is scanned once, not once per chunk.
  let glued;
  function resetGlued() { glued = undefined; }
  function gluedEvents() {
    const events = [];
    while (line.startsWith('data:')) {
      if (!glued) glued = { start: 0, scan: 0, depth: 0, quoted: false, escaped: false, doneFrom: 0 };
      let start = glued.start || 5;
      while (line[start] === ' ' || line[start] === '\t') start++;
      if (start !== glued.start) glued.start = glued.start || 5;
      if (!glued.doneFrom) glued.doneFrom = start;
      const doneToken = '[DONE]';
      if (line.startsWith(doneToken, start)) {
        const end = start + doneToken.length;
        // A terminal frame may omit its blank-line separator at EOF, but do not
        // consume a longer literal value that merely starts with [DONE].
        if (line.length === end || line.startsWith('data:', end)) {
          events.push(doneToken); line = line.slice(end); resetGlued(); continue;
        }
        break;
      }
      if (!['{', '['].includes(line[start])) break;
      let { scan, depth, quoted, escaped } = glued;
      if (!scan) { scan = start; depth = 0; quoted = false; escaped = false; }
      for (; scan < line.length; scan++) {
        const character = line[scan];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{' || character === '[') depth++;
        else if ((character === '}' || character === ']') && --depth === 0) {
          scan++;
          events.push(line.slice(start, scan));
          line = line.slice(scan);
          glued = undefined;
          break;
        }
      }
      if (glued) {
        Object.assign(glued, { scan, depth, quoted, escaped });
        if (line.length - start > maxEventChars) throw new ModelRequestError('Model SSE event exceeds size limit');
        break;
      }
    }
    return events;
  }
  try {
    while (true) {
      const { value, done } = await waitForIO(() => reader.read());
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = !done && skipLF && chunk[0] === '\n' ? 1 : 0;
      skipLF = false;
      const breaks = /\r\n|\r|\n/g;
      breaks.lastIndex = start;
      let match;
      while ((match = breaks.exec(chunk))) {
        line += chunk.slice(start, match.index);
        start = breaks.lastIndex;
        if (!done && match[0] === '\r' && start === chunk.length) skipLF = true;
        const event = accept(line);
        line = ''; resetGlued();
        if (event !== undefined) yield event;
        breaks.lastIndex = start;
      }
      // `done` only flushes the decoder; EOF alone is not an SSE separator.
      if (done) break;
      line += chunk.slice(start);
      for (const event of gluedEvents()) yield event;
      if (line.length > maxEventChars) throw new ModelRequestError('Model SSE event exceeds size limit');
      // EOF alone is not an SSE separator. Only the explicitly supported glued
      // frame form above may complete without a normal blank line.
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseEvent(data) {
  try { return JSON.parse(data); }
  catch (cause) { throw new ModelRequestError('Invalid JSON in model SSE event', { cause }); }
}

function bytesToBase64(value) {
  const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes.toString('base64');
}

/** An image or file part as an http(s) URL or a data URL. */
export function mediaUrl(part, fallbackType = 'image/png') {
  const value = part.image ?? part.data ?? part.url;
  const mimeType = part.mimeType ?? fallbackType;
  if (value instanceof URL) return mediaUrl({ ...part, image: value.href }, fallbackType);
  if (typeof value === 'string') {
    if (/^(https?:\/\/|data:)/i.test(value)) return value;
    if (/^[a-z][\w+.-]*:/i.test(value)) throw new TypeError('Unsupported media URL scheme');
    if (!value.trim()) throw new TypeError('Media content is empty');
    return `data:${mimeType};base64,${value}`;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `data:${mimeType};base64,${bytesToBase64(value)}`;
  throw new TypeError('Media must contain a URL, base64 string, or bytes');
}

export function parseDataUrl(url) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(url);
  return match ? { mediaType: (match[1] ?? 'application/octet-stream').toLowerCase(), data: match[2] } : null;
}

/** File parts the model APIs read natively: PDFs and plain text. Others become a short note. */
export function fileKind(part) {
  const type = String(part.mimeType ?? '').toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || ['application/json', 'application/xml'].includes(type)) return 'text';
  if (type.startsWith('image/')) return 'image';
  return 'other';
}

export function fileText(part) {
  const url = mediaUrl(part, part.mimeType);
  const parsed = parseDataUrl(url);
  return parsed ? Buffer.from(parsed.data, 'base64').toString('utf8') : url;
}

export function unsupportedFileNote(part) {
  return `[Attached file ${part.filename ?? 'without a name'} (${part.mimeType ?? 'unknown type'}) cannot be read by this model API.]`;
}

export function textValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

/** OpenAI-compatible providers reject empty or overlong function names. */
export const validFunctionName = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function messageParts(message) {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
}

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** An explicit level from the policy or router; 'default' and 'auto' mean the model default. */
export function explicitEffort(effort) {
  return EFFORT_ORDER.includes(effort) ? effort : undefined;
}

/**
 * Reasoning produced here is tagged with its API format and model. cursor.* mirrors the
 * original Harness convention (it summarizes and replays by modelName); grokbot.* lets
 * each format replay only reasoning it can read.
 */
export function reasoningProviderOptions({ format, model, providerId, summarized = false, itemId, emptyThinking = false }) {
  return { cursor: { modelName: model, ...(summarized ? { isAlreadySummarizedThinking: true } : {}) },
    grokbot: { format, model, ...(providerId ? { providerId } : {}), ...(itemId ? { itemId } : {}), ...(emptyThinking ? { emptyThinking: true } : {}) } };
}

export function reasoningOrigin(part) {
  const own = part.providerOptions?.grokbot ?? part.experimental_providerMetadata?.grokbot;
  const cursor = part.providerOptions?.cursor ?? part.experimental_providerMetadata?.cursor;
  return { format: own?.format, model: own?.model ?? cursor?.modelName, providerId: own?.providerId, itemId: own?.itemId,
    summarized: cursor?.isAlreadySummarizedThinking === true, phase: own?.phase, emptyThinking: own?.emptyThinking === true };
}

/**
 * Optional request parameters some compatible gateways reject. When a 400 names one of
 * them, the session removes it and retries; the decision is kept for later turns.
 */
export function rejectedOption(error, candidates) {
  if (error?.status !== 400) return undefined;
  const message = String(error.message ?? ''), param = error.param ?? '';
  if (param) return candidates.find(name => param === name || param.startsWith(`${name}.`) || param.startsWith(`${name}[`));
  return candidates.find(name => new RegExp(`(^|[^\\w.])${name.replace(/[.[\]]/g, '\\$&')}(?![\\w])`).test(message));
}

export function deletePath(object, path) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target || typeof target !== 'object') return;
    target = target[key];
  }
  if (target && typeof target === 'object') delete target[keys.at(-1)];
  if (keys.length > 1) {
    const parent = keys.slice(0, -1).reduce((value, key) => value?.[key], object);
    if (parent && typeof parent === 'object' && !Object.keys(parent).length) deletePath(object, keys.slice(0, -1).join('.'));
  }
}

/**
 * POST with bounded retries. Drop a named, rejected option before considering a
 * fallback that changes conversation history (replayed reasoning or inline images).
 */
export async function postWithFallback({ fetchImpl, url, headers, build, signal, apiKey, optional = [], state, fallbacks = [],
  waitForIO = direct, log = message => console.warn(message) }) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const body = build();
    for (const name of state.dropped) deletePath(body, name);
    const http = await waitForIO(() => fetchImpl(url, { method: 'POST', headers: typeof headers === 'function' ? headers(body) : headers,
      body: JSON.stringify(body), signal, redirect: 'error' }));
    if (http.ok) return { http, body };
    const error = await waitForIO(() => errorFromResponse(http, apiKey));
    signal?.throwIfAborted();
    if (attempt < 6) {
      const option = rejectedOption(error, optional.filter(name => !state.dropped.has(name) &&
        name.split('.').reduce((value, key) => value?.[key], body) !== undefined));
      if (option) { state.dropped.add(option); log(`[model] ${new URL(url).host}: retrying without ${option}`); continue; }
      const fallback = fallbacks.find(item => !item.used && item.applies(error, body));
      if (fallback) { fallback.used = true; fallback.apply(); log(`[model] ${new URL(url).host}: ${fallback.name ?? 'fallback'} after HTTP ${error.status ?? 'error'}`); continue; }
    }
    throw error;
  }
}

/** A 400 about reasoning that was replayed from an earlier turn. */
export function replayRejected(error) {
  // Gateways join words with underscores (native_thinking_replay_mismatch): no word boundaries.
  return error?.status === 400 && /signature|thinking|encrypted|reasoning/i.test(`${error.message ?? ''} ${error.code ?? ''}`);
}

function plainUserDelivery(call) {
  const args = call?.args;
  if (call?.type !== 'tool-call' || call.toolName !== 'SendToUser' || args?.type !== 'text' ||
      typeof args.content !== 'string' || !args.content || Object.keys(args).length !== 2) return undefined;
  return args.content;
}

// A fresh provider ID does not prove fresh work. Inspect only the immediately preceding
// successful exchange, never search across user turns, other tools or conversations.
function isRepeatedDelivery(calls, messages) {
  if (calls.length !== 1 || !messages || messages.length < 2) return false;
  const text = plainUserDelivery(calls[0]);
  if (text === undefined) return false;
  const receipt = messages.at(-1), previous = messages.at(-2);
  if (receipt?.role !== 'tool' || previous?.role !== 'assistant' ||
      receipt.providerOptions?.cursor?.highLevelToolCallResult?.isError !== false) return false;
  const parts = messageParts(receipt), sent = messageParts(previous).filter(part => part.type === 'tool-call');
  return parts.length === 1 && sent.length === 1 && plainUserDelivery(sent[0]) === text &&
    parts[0].type === 'tool-result' && parts[0].toolName === 'SendToUser' && !parts[0].isError &&
    Boolean(sent[0].toolCallId) && parts[0].toolCallId === sent[0].toolCallId && receipt.id === sent[0].toolCallId;
}

export function* streamToolCalls(calls, messages, signal) {
  if (new Set(calls.map(call => call.toolCallId)).size !== calls.length) throw new ModelRequestError('Duplicate model tool call ID');
  if (isRepeatedDelivery(calls, messages)) {
    throw new ModelRequestError('The model requested the same text that was already delivered. Stopped this turn before sending it again.',
      { code: 'repeated_user_delivery' });
  }
  const discard = recordToolCallOrder(calls);
  let handedOff = 0;
  const discardUnhanded = () => {
    for (let i = handedOff; i < calls.length; i++) discard(calls[i].toolCallId);
  };
  signal?.addEventListener('abort', discardUnhanded, { once: true });
  try {
    for (const call of calls) {
      // The Harness consumes one argument stream at a time; serialize parallel calls.
      yield { type: 'tool-call-streaming-start', toolCallId: call.toolCallId, toolName: call.toolName };
      yield { type: 'tool-call-delta', toolCallId: call.toolCallId, toolName: call.toolName, argsTextDelta: JSON.stringify(call.args) };
      handedOff++;
      yield call;
    }
  } finally {
    // Already delivered calls still need their ordering entries until journal execution.
    signal?.removeEventListener('abort', discardUnhanded);
    discardUnhanded();
  }
}

export function serializeToolCalls(calls) {
  return [...streamToolCalls(calls)];
}

export function parseToolArguments(name, text) {
  try { return JSON.parse(text); }
  catch (cause) { throw new ModelRequestError(`Invalid tool arguments for ${name}`, { cause }); }
}

/** JSON Schema of a Harness tool. */
export function toolSchema(tool) {
  if (tool.type === 'provider-defined' || tool.customToolFormat) throw new TypeError('This session supports JSON function tools only');
  if (typeof tool.name !== 'string' || !tool.name) throw new TypeError('Tool name is required');
  const parameters = tool.parameters?.jsonSchema ?? tool.parameters;
  if (!parameters || typeof parameters !== 'object') throw new TypeError('Tool schema is required');
  return { name: tool.name, description: tool.description ?? '', parameters };
}
