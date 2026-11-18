import { catalogContextPolicy, defaultPolicy, effortLevels, parseModelPolicy, validatePolicy, EFFORTS } from '../runtime/model-policy.mjs';
import { createModelRouter } from '../runtime/model-router.mjs';
import { anthropicEndpoint, anthropicHeaders } from '../runtime/anthropic-messages.mjs';
import { createModelSession } from '../runtime/model-session.mjs';
import { API_FORMATS, MODEL_ROUTING_ENV, isConfiguredModelRouting, modelRouteForAgent, modelRouteForProfile,
  parseModelRouting, publicModelRouting, validateModelProvider, validateModelRouting } from '../runtime/model-routing.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check } from './security.mjs';
import { readJson, writePrivate } from './storage.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clean = (value, label, maximum = 2048) => {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value), 400,
    `${label}不能为空，也不能包含换行`);
  return value.trim();
};

function valuesFrom(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

function legacyConfig(values) {
  return {
    apiFormat: API_FORMATS.includes(values.MODEL_API_FORMAT) ? values.MODEL_API_FORMAT : 'openai',
    baseUrl: values.OPENAI_BASE_URL ?? '', model: values.OPENAI_MODEL ?? '', apiKey: values.OPENAI_API_KEY ?? '',
    contextWindowTokens: Number(values.OPENAI_CONTEXT_WINDOW_TOKENS ?? 0),
    policy: parseModelPolicy(values.GROKBOT_MODEL_POLICY, values.OPENAI_MODEL || undefined),
    jevApiKey: values.JEV_API_KEY || '',
  };
}

function context(value) {
  const parsed = Number(value ?? 0);
  check(Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100_000_000, 400,
    '上下文长度应为 0–100000000 的整数');
  return parsed;
}

function serviceUrl(value) {
  const baseUrl = clean(value, 'Base URL');
  let url;
  try { url = new URL(baseUrl); }
  catch { check(false, 400, 'Base URL 格式不正确'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    400, 'Base URL 需要 HTTP(S) 地址，不能包含凭证或查询参数');
  return url.href.replace(/\/$/, '');
}

function publicError(error) {
  return `模型配置无效：${String(error?.message ?? error).slice(0, 240)}`;
}

function compatibilityPolicy(route) {
  const policy = defaultPolicy(route.model);
  policy.effort = route.effort;
  policy.models = [{ id: route.model, efforts: route.efforts,
    contextWindowTokens: route.contextWindowTokens, summaryThresholdTokens: route.summaryThresholdTokens }];
  return policy;
}

export class Models {
  constructor(dataDir, { filename = join(dataDir, 'model.env') } = {}) {
    this.filename = filename;
    this.dataDir = dataDir;
    this.tail = Promise.resolve();
  }
  async current() {
    const source = await readFile(this.filename, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const values = valuesFrom(source), legacy = legacyConfig(values);
    const parsed = parseModelRouting(values[MODEL_ROUTING_ENV], legacy);
    let primary;
    try { primary = modelRouteForAgent(parsed.config); }
    catch { primary = undefined; }
    return { ...legacy, routing: parsed.config, routingMigrated: parsed.migrated,
      legacyAdaptiveRouting: parsed.migrated && legacy.policy?.mode === 'adaptive',
      ...(primary ? { baseUrl: primary.baseUrl, apiKey: primary.apiKey, apiFormat: primary.apiFormat,
        model: primary.model, contextWindowTokens: primary.contextWindowTokens, policy: compatibilityPolicy(primary) } : {}) };
  }
  async publicConfig() {
    const current = await this.current();
    const { apiKey, jevApiKey, routing, ...summary } = current;
    return {
      ...publicModelRouting(routing),
      ...summary,
      hasApiKey: Boolean(apiKey), hasJevApiKey: Boolean(jevApiKey),
      configured: isConfiguredModelRouting(routing),
      reload: await this.reloadStatus(),
    };
  }
  async reloadStatus() {
    const request = await readJson(join(this.dataDir, 'model-reload-request.json'), null);
    const status = await readJson(join(this.dataDir, 'model-reload-status.json'), null);
    if (!request) return status ?? { status: 'none' };
    if (status?.revision === request.revision) {
      const allowed = ['applied', 'waiting', 'error', 'pending'];
      return { revision: status.revision, status: allowed.includes(status.status) ? status.status : 'pending',
        updatedAt: status.updatedAt, message: status.status === 'error' ? 'Host 未能应用配置，请检查服务日志' : undefined };
    }
    return { revision: request.revision, status: 'pending', updatedAt: request.requestedAt };
  }
  legacyRouting(input, previous) {
    const apiFormat = input.apiFormat ?? previous.apiFormat;
    check(API_FORMATS.includes(apiFormat), 400, '接口格式无效');
    const baseUrl = serviceUrl(input.baseUrl ?? previous.baseUrl);
    const model = clean(input.model ?? previous.model, '模型名称', 256);
    const active = (() => { try { return modelRouteForAgent(previous.routing); } catch { return undefined; } })();
    const apiKey = clean(input.apiKey || active?.apiKey || previous.apiKey, 'API Key', 8192);
    const contextWindowTokens = context(input.contextWindowTokens ?? active?.contextWindowTokens ?? previous.contextWindowTokens);
    let policy;
    try {
      policy = validatePolicy(input.policy ?? (previous.model === model ? previous.policy : defaultPolicy(model)), model);
    } catch (error) { check(false, 400, error.message); }
    check(policy.mode !== 'adaptive' || (input.jevApiKey || previous.jevApiKey), 400, '请填写 Jev API Key');
    const providerId = active?.providerId ?? 'default', profileId = active?.profileId ?? 'default';
    const capability = policy.models.find(item => item.id === model) ?? { efforts: effortLevels(model) };
    const providers = (previous.routing.providers ?? []).filter(item => item.id !== providerId);
    providers.push({ id: providerId, name: active?.providerName ?? '默认服务', apiFormat, baseUrl, apiKey });
    const profiles = (previous.routing.profiles ?? []).filter(item => item.id !== profileId);
    profiles.push({ id: profileId, name: active?.profileName ?? '默认模型', providerId, model,
      efforts: capability.efforts, contextWindowTokens: capability.contextWindowTokens ?? contextWindowTokens,
      summaryThresholdTokens: capability.summaryThresholdTokens ?? 0 });
    let routing;
    try {
      routing = validateModelRouting({ version: 1, providers, profiles,
        defaultRoute: { profileId, effort: policy.effort, fallbacks: previous.routing.defaultRoute?.fallbacks ?? [] },
        botRoutes: previous.routing.botRoutes ?? {} }, { previous: previous.routing });
    } catch (error) { check(false, 400, publicError(error)); }
    return { routing, jevApiKey: input.jevApiKey ? clean(input.jevApiKey, 'Jev API Key', 8192) : previous.jevApiKey,
      ...(previous.routingMigrated ? { legacy: { apiFormat, baseUrl, apiKey, model, contextWindowTokens, policy } } : {}) };
  }
  async validated(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '模型配置无效');
    const previous = await this.current();
    const multiProvider = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1;
    if (!multiProvider) return this.legacyRouting(input, previous);
    check(!previous.routingMigrated || input.migrateLegacyRouting === true, 409,
      '检测到旧版模型配置。请在模型页确认迁移后再保存。');
    let routing;
    try { routing = validateModelRouting(input, { previous: previous.routing }); }
    catch (error) { check(false, 400, publicError(error)); }
    return { routing, jevApiKey: input.jevApiKey ? clean(input.jevApiKey, 'Jev API Key', 8192) : previous.jevApiKey };
  }
  async write(config) {
    if (config.legacy) {
      const { apiFormat, baseUrl, apiKey, model, contextWindowTokens, policy } = config.legacy;
      await writePrivate(this.filename, [
        `MODEL_API_FORMAT=${apiFormat}`,
        `OPENAI_BASE_URL=${baseUrl}`,
        `OPENAI_API_KEY=${apiKey}`,
        `OPENAI_MODEL=${model}`,
        `OPENAI_CONTEXT_WINDOW_TOKENS=${contextWindowTokens}`,
        `GROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
        `JEV_API_KEY=${config.jevApiKey}`,
        '',
      ].join('\n'));
      return;
    }
    const primary = modelRouteForAgent(config.routing);
    const policy = compatibilityPolicy(primary);
    await writePrivate(this.filename, [
      `${MODEL_ROUTING_ENV}=${JSON.stringify(config.routing)}`,
      `MODEL_API_FORMAT=${primary.apiFormat}`,
      `OPENAI_BASE_URL=${primary.baseUrl}`,
      `OPENAI_API_KEY=${primary.apiKey}`,
      `OPENAI_MODEL=${primary.model}`,
      `OPENAI_CONTEXT_WINDOW_TOKENS=${primary.contextWindowTokens}`,
      `GROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
      `JEV_API_KEY=${config.jevApiKey}`,
      '',
    ].join('\n'));
  }
  save(input) {
    const pending = this.tail.then(async () => {
      const config = await this.validated(input);
      await this.write(config);
      const request = { revision: randomUUID(), requestedAt: new Date().toISOString() };
      await writePrivate(join(this.dataDir, 'model-reload-request.json'), `${JSON.stringify(request)}\n`);
      return this.publicConfig();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  async routeFor(input = {}, { profileId, direct = false } = {}) {
    const hasConfig = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1 || own(input, 'baseUrl');
    const config = hasConfig ? await this.validated(input) : { routing: (await this.current()).routing };
    if (profileId) return { config, route: modelRouteForProfile(config.routing, profileId) };
    const route = modelRouteForAgent(config.routing);
    return { config, route: direct ? { ...route, fallbacks: [] } : route };
  }
  async catalog(input = {}) {
    const previous = await this.current();
    let provider;
    if (input.provider) {
      try { provider = validateModelProvider(input.provider, { previous: previous.routing }); }
      catch (error) { check(false, 400, publicError(error)); }
    } else if (input.providerId && !Array.isArray(input.providers) && !own(input, 'baseUrl')) {
      provider = previous.routing.providers.find(item => item.id === input.providerId);
      check(provider, 404, '模型服务不存在');
    } else {
      const { route } = await this.routeFor(input, { profileId: input.profileId, direct: true });
      provider = route;
    }
    let response;
    const anthropic = provider.apiFormat === 'anthropic';
    try {
      response = await fetch(anthropic ? anthropicEndpoint(provider.baseUrl, 'models') : `${provider.baseUrl}/models`, {
        redirect: 'error', headers: anthropic ? anthropicHeaders(provider.apiKey) : { authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch { check(false, 502, '无法读取模型列表'); }
    check(response.ok, 502, `Model catalog HTTP ${response.status}`);
    const body = await response.json();
    check(Array.isArray(body.data), 502, '模型列表格式不兼容');
    return { models: body.data.filter(item => typeof item.id === 'string').slice(0, 200).map(item => {
      const supplied = item.supported_reasoning_efforts ?? item.supported_efforts ?? item.reasoning_effort?.values ?? item.capabilities?.reasoning_efforts;
      const levels = Array.isArray(supplied) ? EFFORTS.filter(level => supplied.includes(level)) : null;
      const capacity = [item.context_window, item.max_input_tokens, item.context_length]
        .find(value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000);
      return { id: item.id, efforts: levels ?? effortLevels(item.id), source: levels ? 'provider' : effortLevels(item.id).length ? 'reference' : 'manual',
        ...catalogContextPolicy(item.id, capacity) };
    }) };
  }
  async classify(input) {
    const current = await this.current();
    const base = { ...current, ...(input ?? {}) };
    const config = await this.legacyRouting(base, current);
    const route = modelRouteForAgent(config.routing);
    check(config.jevApiKey, 400, '请填写 Jev API Key');
    const policy = { ...compatibilityPolicy(route), mode: 'adaptive' };
    const router = createModelRouter({ ...route, policy, jevApiKey: config.jevApiKey,
      usageDirectory: join(this.dataDir, 'usage'), routingDirectory: join(this.dataDir, 'routing'), routingSource: 'test' });
    const decision = await router({ messages: [{ role: 'user', content: clean(input.task, '任务', 10000) }] });
    const { requestOptions, apiKey, baseUrl, ...result } = decision;
    return result;
  }
  async test(input = {}) {
    const { config, route } = await this.routeFor(input, { profileId: input.profileId, direct: true });
    let usage;
    const session = createModelSession({ ...route, policy: compatibilityPolicy(route),
      onUsage: async value => { usage = value; }, selectRequest: async () => ({ ...route, fallbacks: [] }) });
    const result = session.getExecutor([{ role: 'user', content: 'Reply with OK.' }])
      .stream({ signal: AbortSignal.timeout(120_000) }, 'model-test', []);
    let text = '';
    try {
      for await (const part of result.fullStream) if (part.type === 'text-delta') text += part.textDelta;
      await result.response;
    } catch (error) {
      check(false, 502, error.name === 'TimeoutError' || error.name === 'AbortError' ? '模型服务连接超时，请检查地址与网络'
        : error.status ? `模型服务返回 HTTP ${error.status}：${String(error.message).slice(0, 300)}`
          : `模型请求失败：${String(error.message).slice(0, 300)}`);
    } finally {
      if (usage) await recordUsage(join(this.dataDir, 'usage'), { ...usage, kind: 'test' }).catch(() => {});
    }
    check(text.trim(), 502, '模型没有返回文字内容');
    return { ok: true, profileId: route.profileId, model: route.model, message: '模型接口已完成真实请求' };
  }
}
