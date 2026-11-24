import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VoiceConfig } from '../server/voice-config.mjs';
import { VoiceSynthesis } from '../server/voice-synthesis.mjs';
import { selectVoiceCandidate } from '../server/voice-selection.mjs';

const key = 'fixture-voice-credential';
const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'grokbot-voice-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await new VoiceConfig(directory).load();
  return { directory, config, synthesis: new VoiceSynthesis(config) };
}

async function upstream(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('OpenAI-compatible TTS saves privately and sends the documented PCM request', async t => {
  const value = await fixture(t);
  let received;
  const origin = await upstream(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { path: request.url, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    response.writeHead(200, { 'content-type': 'audio/pcm' });
    response.write(pcm.subarray(0, 3));
    response.end(pcm.subarray(3));
  });

  const saved = await value.config.save({ enabled: true, tts: {
    provider: 'openai', endpoint: `${origin}/v1/audio/speech`, apiKey: key,
    model: 'gpt-4o-mini-tts', voice: 'alloy', speed: 1.25,
  } });
  assert.equal(saved.tts.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes(key), false);

  assert.deepEqual(Buffer.concat(await Array.fromAsync(value.synthesis.stream('Hello'))), pcm);
  assert.deepEqual(received, {
    path: '/v1/audio/speech', authorization: `Bearer ${key}`,
    body: { input: 'Hello', model: 'gpt-4o-mini-tts', voice: 'alloy', response_format: 'pcm', speed: 1.25 },
  });
  const persisted = await readFile(join(value.directory, 'voice.json'), 'utf8');
  assert.match(persisted, new RegExp(key));
  assert.equal(createHash('sha256').update(persisted).digest('hex').length, 64);
  await value.synthesis.close();
});

test('Fish TTS uses its own payload and cannot reuse a credential at another origin', async t => {
  const value = await fixture(t);
  let received;
  const origin = await upstream(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { authorization: request.headers.authorization, model: request.headers.model,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(pcm);
  });
  await value.config.save({ enabled: true, tts: {
    provider: 'fish', endpoint: `${origin}/v1/tts`, apiKey: key, referenceId: 'voice_test',
    model: 'fish-model', speed: 0.75, latency: 'low',
  } });
  assert.deepEqual(Buffer.concat(await Array.fromAsync(value.synthesis.stream('你好'))), pcm);
  assert.deepEqual(received, {
    authorization: `Bearer ${key}`, model: 'fish-model',
    body: { text: '你好', format: 'pcm', sample_rate: 24000, latency: 'low',
      prosody: { speed: 0.75 }, reference_id: 'voice_test' },
  });
  await assert.rejects(value.config.save({ enabled: true, tts: {
    provider: 'fish', endpoint: 'https://elsewhere.invalid/v1/tts', apiKeySource: 'speech', referenceId: 'voice_test',
  } }), error => error.status === 400 && error.message === 'A Fish speech key with the same service origin is required');
  await value.synthesis.close();
});

test('voice configuration rejects missing required fields and hides API keys', async t => {
  const value = await fixture(t);
  await assert.rejects(value.config.save({ enabled: true, tts: {
    provider: 'openai', endpoint: 'https://voice.example.invalid/v1/audio/speech', model: '', voice: '',
  } }), error => error.status === 400 && error.message === 'Voice model is required');
  const saved = await value.config.save({ enabled: false, tts: {
    provider: 'openai', endpoint: 'https://voice.example.invalid/v1/audio/speech', apiKey: key,
    model: 'demo-tts', voice: 'alloy',
  } });
  assert.equal(saved.tts.hasApiKey, true);
  assert.equal(Object.hasOwn(saved.tts, 'apiKey'), false);
  await value.synthesis.close();
});

test('automatic selection chooses the strongest matching candidate and otherwise preserves the default', async t => {
  const value = await fixture(t);
  await value.config.save({ enabled: true, tts: {
    provider: 'openai', endpoint: 'https://voice.example.invalid/v1/audio/speech', apiKey: key,
    model: 'demo-tts', voice: 'alloy',
  }, selection: { enabled: true, candidates: [
    { id: 'analyst', name: 'Analyst', provider: 'openai', voice: 'sage', keywords: ['research', 'analysis'], languages: ['en'] },
    { id: 'host', name: 'Host', provider: 'openai', voice: 'echo', keywords: ['主持人'], languages: ['zh'] },
    { id: 'fish-only', name: 'Fish', provider: 'fish', referenceId: 'fish-ref', keywords: ['research'], languages: ['en'] },
  ] } });

  const selected = value.config.resolveSynthesisConfig({ name: 'Research Bot', description: 'Deep analysis and research.' });
  assert.equal(selected.voice, 'sage');
  assert.equal(Object.hasOwn(selected, 'selectedVoice'), false);
  assert.equal(value.config.resolveSynthesisConfig({ name: 'General Bot' }).voice, 'alloy');
  // Internal Host fields such as purpose ("plugin-auth", "disk-saver") must not match or skew language detection.
  assert.equal(
    selectVoiceCandidate(
      { enabled: true, candidates: [{ id: 'plug', provider: 'openai', voice: 'sage', keywords: ['plugin', 'auth'], languages: ['en'] }] },
      'openai',
      { name: '日常助手', purpose: 'plugin-auth', role: 'plugin' },
    ),
    null,
  );
  assert.equal(selectVoiceCandidate({ enabled: false, candidates: [{ provider: 'openai', voice: 'sage', keywords: ['research'] }] }, 'openai', { name: 'Research' }), null);
  assert.equal(selectVoiceCandidate({ enabled: true, candidates: [
    { id: 'zulu', provider: 'openai', keywords: ['research'], languages: [] },
    { id: 'alpha', provider: 'openai', keywords: ['research'], languages: [] },
  ] }, 'openai', { name: 'Research' }).candidate.id, 'alpha');
  assert.equal(selectVoiceCandidate({ enabled: true, candidates: [
    { id: 'localized', provider: 'openai', keywords: ['research'], languages: ['en_US'] },
  ] }, 'openai', { name: 'Research' }).language, 'en');
  await value.synthesis.close();
});

test('a Bot-specific voice stays selected after the default voice changes', async t => {
  const value = await fixture(t);
  const received = [];
  const origin = await upstream(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).voice);
    response.writeHead(200, { 'content-type': 'audio/pcm' }); response.end(pcm);
  });
  await value.config.save({ enabled: true, tts: {
    provider: 'openai', endpoint: `${origin}/v1/audio/speech`, apiKey: key, model: 'demo-tts', voice: 'alloy',
  }, selection: { enabled: true, candidates: [
    { id: 'analyst', name: 'Analyst', provider: 'openai', voice: 'sage', keywords: ['research'], languages: ['en'] },
  ] } });
  await value.config.save({ enabled: true, tts: { voice: 'nova' } });
  await Array.fromAsync(value.synthesis.stream('First', { agent: { name: 'Research Bot' } }));
  await Array.fromAsync(value.synthesis.stream('Second'));
  assert.deepEqual(received, ['sage', 'nova']);
  await value.synthesis.close();
});
