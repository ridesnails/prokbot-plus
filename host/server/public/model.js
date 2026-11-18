import { t, html } from './i18n.js';
import { $, node, item, badge, empty, iconButton, menu, confirmAction } from './ui.js';
import { createRoutingLog } from './routing-log.js';
import { clientId } from './ids.js';

const formats = [
  ['openai', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic', 'Anthropic Messages'],
];
const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const levelLabels = { default: '模型默认', none: '无', minimal: '极低', low: '轻度', medium: '中度', high: '高度', xhigh: '超高', max: '最高' };
const defaultUrls = { openai: 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
const defaultContextWindowTokens = 0, defaultSummaryThresholdTokens = 0;

const clone = value => structuredClone(value);
const uid = prefix => clientId(prefix);
const choice = (select, values, selected) => {
  select.replaceChildren(...values.map(([value, label]) => new Option(t(label), value)));
  select.value = values.some(([value]) => value === selected) ? selected : values[0]?.[0] ?? '';
};
const parseTokenCount = value => {
  const source = String(value ?? '').trim();
  if (!source) return 0;
  const match = source.match(/^(\d+(?:\.\d*)?|\.\d+)\s*([km]?)$/i);
  if (!match) return NaN;
  const precision = { '': 0, k: 3, m: 6 }[match[2].toLowerCase()];
  const [whole, decimals = ''] = match[1].split('.');
  const fraction = decimals.replace(/0+$/, '');
  if (fraction.length > precision) return NaN;
  const number = Number((whole || '0') + fraction.padEnd(precision, '0'));
  return Number.isSafeInteger(number) && number <= 100_000_000 ? number : NaN;
};
const formatTokenCount = value => {
  if (!value) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(6).replace(/\.?0+$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(3).replace(/\.?0+$/, '')}K`;
  return String(value);
};
const emptyRouting = () => ({ version: 1, providers: [], profiles: [], defaultRoute: null, botRoutes: {} });

function editor(panel, id) {
  const dialog = node('dialog', 'dialog wide');
  dialog.id = id;
  const form = document.createElement('form');
  const head = node('div', 'dialog-head'), title = node('h2'), body = node('div', 'dialog-body'), foot = node('div', 'dialog-foot');
  const cancel = node('button', 'btn', t('取消')); cancel.type = 'button'; cancel.onclick = () => dialog.close();
  const submit = node('button', 'btn btn-primary', t('保存')); submit.type = 'submit';
  head.append(title, iconButton('close', t('关闭'), () => dialog.close()));
  foot.append(cancel, submit); form.append(head, body, foot); dialog.append(form); panel.append(dialog);
  return { dialog, form, title, body, submit };
}

function formField(parent, name, label, type = 'text') {
  const field = node('label', 'field', t(label));
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  input.name = name;
  if (type === 'password') { input.autocomplete = 'new-password'; input.dataset.private = ''; }
  if (type === 'url') { input.spellcheck = false; input.dataset.private = ''; }
  field.append(input); parent.append(field);
  return input;
}

function formSelect(parent, name, label) {
  const field = node('label', 'field', t(label)), select = document.createElement('select');
  select.name = name; field.append(select); parent.append(field); return select;
}

export function createModelPage({ api, toast, busy, refresh }) {
  const panel = $('[data-panel=model]');
  panel.innerHTML = html(`<header class="page-header"><h1>对话模型</h1></header>
    <form id="model-form" class="sections">
      <section class="section"><div class="section-head"><h2 class="section-title">模型服务</h2><div class="section-actions"><button id="add-model-provider" class="icon-btn" type="button" aria-label="添加模型服务"></button></div></div><div id="model-providers" class="card"></div></section>
      <section class="section"><div class="section-head"><h2 class="section-title">模型档案</h2><div class="section-actions"><button id="add-model-profile" class="icon-btn" type="button" aria-label="添加模型档案"></button></div></div><div id="model-profiles" class="card"></div></section>
      <section class="section"><div class="section-head"><h2 class="section-title">默认路由</h2></div><div id="model-default-route" class="card"></div></section>
      <section class="section"><div class="section-head"><h2 class="section-title">Bot 路由</h2><div class="section-actions"><button id="refresh-model-bots" class="icon-btn" type="button" aria-label="刷新 Bot"></button></div></div><div id="model-bot-routes" class="card"></div></section>
      <p id="legacy-routing-notice" class="hint" role="status" hidden></p>
      <p id="model-error" class="error" role="alert" hidden></p>
      <div class="actions"><span id="model-apply-title" class="status-text" role="status"></span><button type="submit" class="btn btn-primary">保存配置</button></div>
    </form>
    <section class="section"><div class="section-head"><h2 class="section-title">模型路由记录</h2><div class="section-actions"><button id="refresh-routing" class="icon-btn" type="button" aria-label="刷新"></button></div></div><div id="routing-log" class="card"></div></section>`);
  const form = $('#model-form'), providersRoot = $('#model-providers'), profilesRoot = $('#model-profiles');
  const defaultRoot = $('#model-default-route'), botsRoot = $('#model-bot-routes'), routingLog = createRoutingLog({ api });
  const providerEditor = editor(panel, 'model-provider-editor'), profileEditor = editor(panel, 'model-profile-editor');
  const botEditor = editor(panel, 'model-bot-route-editor');
  let config = emptyRouting(), pendingKeys = new Map(), loaded = false, dirty = false, active = false, agents = [],
    agentSignature = '', legacyRouting = false, legacyAdaptive = false;

  function profileById(id) { return config.profiles.find(profile => profile.id === id); }
  function providerById(id) { return config.providers.find(provider => provider.id === id); }
  function profileLabel(profile) {
    const provider = providerById(profile.providerId);
    return `${profile.name} · ${profile.model}${provider ? ` · ${provider.name}` : ''}`;
  }
  function providerHasKey(provider) { return Boolean(pendingKeys.get(provider.id) || provider.hasApiKey); }
  function effortFor(profile, value) { return profile?.efforts?.includes(value) ? value : 'default'; }
  function routeCopy(route) {
    const primary = profileById(route?.profileId) ?? config.profiles[0];
    if (!primary) return null;
    const seen = new Set([primary.id]);
    const fallbacks = [];
    for (const item of route?.fallbacks ?? []) {
      const profile = profileById(item.profileId);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id); fallbacks.push({ profileId: profile.id, effort: effortFor(profile, item.effort) });
    }
    return { profileId: primary.id, effort: effortFor(primary, route?.effort), fallbacks };
  }
  function routeDescription(route) {
    const current = routeCopy(route);
    if (!current) return t('尚未配置');
    const primary = profileById(current.profileId);
    const fallback = current.fallbacks.map(item => profileById(item.profileId)?.name).filter(Boolean);
    return `${primary?.name ?? current.profileId} · ${t(levelLabels[current.effort] ?? current.effort)}${fallback.length ? ` → ${fallback.join(' → ')}` : ''}`;
  }
  function markDirty() {
    dirty = true;
    $('#model-apply-title').textContent = t('有未保存的修改');
  }
  function applyText(value) {
    if (!value?.configured) return t('保存后启动 Host');
    return t({ applied: '配置已应用', waiting: '任务结束后应用', pending: '任务结束后应用', error: '配置应用失败，请检查 Host 日志' }[value.reload?.status] ?? '配置已保存');
  }
  function serializedProvider(provider) {
    return { id: provider.id, name: provider.name, apiFormat: provider.apiFormat, baseUrl: provider.baseUrl,
      apiKey: pendingKeys.get(provider.id) ?? '' };
  }
  function input() {
    if (!config.providers.length) throw new Error(t('请先添加模型服务。'));
    if (!config.profiles.length) throw new Error(t('请先添加模型档案。'));
    if (!config.defaultRoute) throw new Error(t('请设置默认路由。'));
    for (const provider of config.providers) if (!providerHasKey(provider))
      throw new Error(t('请填写“{0}”的 API Key。', provider.name));
    return { version: 1, ...(legacyRouting ? { migrateLegacyRouting: true } : {}), providers: config.providers.map(serializedProvider), profiles: config.profiles.map(profile => ({
      id: profile.id, name: profile.name, providerId: profile.providerId, model: profile.model, efforts: [...profile.efforts],
      contextWindowTokens: profile.contextWindowTokens ?? 0, summaryThresholdTokens: profile.summaryThresholdTokens ?? 0,
    })), defaultRoute: routeCopy(config.defaultRoute), botRoutes: Object.fromEntries(Object.entries(config.botRoutes)
      .map(([id, route]) => [id, routeCopy(route)]).filter(([, route]) => route)) };
  }
  function setConfig(value) {
    legacyRouting = value.routingMigrated === true;
    // Only an adaptive policy used task-difficulty routing; a single model converts without loss.
    legacyAdaptive = legacyRouting && value.legacyAdaptiveRouting === true;
    config = { version: 1, providers: (value.providers ?? []).map(provider => ({ ...provider })),
      profiles: (value.profiles ?? []).map(profile => ({ ...profile, efforts: [...(profile.efforts ?? [])] })),
      defaultRoute: null, botRoutes: clone(value.botRoutes ?? {}) };
    config.defaultRoute = value.defaultRoute ? routeCopy(value.defaultRoute) : null;
    config.botRoutes = Object.fromEntries(Object.entries(config.botRoutes)
      .map(([id, route]) => [id, routeCopy(route)]).filter(([, route]) => route));
    pendingKeys = new Map(); dirty = false; loaded = true; render();
    const notice = $('#legacy-routing-notice');
    notice.hidden = !legacyRouting;
    notice.textContent = !legacyRouting ? '' : legacyAdaptive
      ? t('当前仍使用旧版按任务难度路由（Jev）。保存后会迁移为按 Bot 路由，并移除智能路由界面；如需保留旧配置，请不要保存。')
      : t('当前是旧版单模型配置。保存后会转成服务和档案的格式，模型、API Key 和思考强度不变。');
    $('#model-apply-title').textContent = applyText(value);
  }
  function providerOptions(select, selected) {
    choice(select, config.providers.map(provider => [provider.id, provider.name]), selected);
  }
  function profileOptions(select, selected, excluded = new Set()) {
    choice(select, config.profiles.filter(profile => !excluded.has(profile.id)).map(profile => [profile.id, profileLabel(profile)]), selected);
  }
  function effortOptions(select, profileId, selected) {
    const profile = profileById(profileId);
    choice(select, [['default', '模型默认'], ...(profile?.efforts ?? []).map(level => [level, levelLabels[level]])], effortFor(profile, selected));
  }
  function routeEditor(root, route, onChange) {
    const current = routeCopy(route);
    if (!current) return;
    const update = next => onChange(routeCopy(next));
    const primary = node('div', 'row'), primaryCopy = node('span', 'row-copy'), primaryControl = node('span', 'row-control wide');
    primaryCopy.append(node('span', 'row-title', t('主模型')));
    const primaryProfile = document.createElement('select'), primaryEffort = document.createElement('select');
    primaryProfile.setAttribute('aria-label', t('主模型')); primaryEffort.setAttribute('aria-label', t('思考强度'));
    profileOptions(primaryProfile, current.profileId); effortOptions(primaryEffort, current.profileId, current.effort);
    primaryProfile.onchange = () => {
      const nextProfile = profileById(primaryProfile.value);
      update({ ...current, profileId: primaryProfile.value, effort: effortFor(nextProfile, current.effort),
        fallbacks: current.fallbacks.filter(item => item.profileId !== primaryProfile.value) });
    };
    primaryEffort.onchange = () => update({ ...current, effort: primaryEffort.value });
    primaryControl.append(primaryProfile, primaryEffort); primary.append(primaryCopy, primaryControl); root.append(primary);
    current.fallbacks.forEach((fallback, index) => {
      const line = node('div', 'row'), copy = node('span', 'row-copy'), control = node('span', 'row-control wide');
      copy.append(node('span', 'row-title', t('备用模型 {0}', index + 1)));
      const excluded = new Set([current.profileId, ...current.fallbacks.filter((_, itemIndex) => itemIndex !== index).map(item => item.profileId)]);
      const profile = document.createElement('select'), effort = document.createElement('select');
      profile.setAttribute('aria-label', t('备用模型 {0}', index + 1)); effort.setAttribute('aria-label', t('思考强度'));
      profileOptions(profile, fallback.profileId, excluded); effortOptions(effort, fallback.profileId, fallback.effort);
      profile.onchange = () => {
        const next = clone(current); next.fallbacks[index].profileId = profile.value;
        next.fallbacks[index].effort = effortFor(profileById(profile.value), fallback.effort); update(next);
      };
      effort.onchange = () => { const next = clone(current); next.fallbacks[index].effort = effort.value; update(next); };
      const remove = iconButton('close', t('移除备用模型'));
      remove.onclick = () => { const next = clone(current); next.fallbacks.splice(index, 1); update(next); };
      control.append(profile, effort, remove); line.append(copy, control); root.append(line);
    });
    const used = new Set([current.profileId, ...current.fallbacks.map(item => item.profileId)]);
    const nextProfile = config.profiles.find(profile => !used.has(profile.id));
    const add = iconButton('plus', t('添加备用模型'));
    add.disabled = !nextProfile;
    add.onclick = () => update({ ...current, fallbacks: [...current.fallbacks, { profileId: nextProfile.id, effort: 'default' }] });
    const actions = node('div', 'actions'); actions.append(add); root.append(actions);
  }
  function renderProviders() {
    providersRoot.replaceChildren();
    if (!config.providers.length) {
      providersRoot.append(empty(t('还没有模型服务'), t('添加一个模型服务后，再创建模型档案。')));
      return;
    }
    for (const provider of config.providers) {
      const linked = config.profiles.filter(profile => profile.providerId === provider.id);
      const more = menu(t('{0} 的更多操作', provider.name), [
        { label: t('编辑'), run: () => showProvider(provider) },
        { label: t('删除'), danger: true, disabled: linked.length > 0, run: trigger => busy(trigger, async () => {
          if (!await confirmAction({ title: t('删除“{0}”？', provider.name), message: t('请先移除或改用引用此服务的模型档案。'), action: t('删除') })) return;
          config.providers = config.providers.filter(item => item.id !== provider.id); pendingKeys.delete(provider.id); markDirty(); render();
        }) },
      ]);
      providersRoot.append(item({ icon: 'model', title: provider.name,
        badges: [badge(provider.apiFormat), badge(providerHasKey(provider) ? t('已配置') : t('缺少 API Key'), providerHasKey(provider) ? 'success' : 'danger')],
        meta: [provider.baseUrl, linked.length ? t('{0} 个模型档案', linked.length) : t('尚未创建模型档案')], actions: [more] }));
    }
  }
  async function testProfile(profile) {
    const result = await api('/admin/api/model/test', { method: 'POST', body: { ...input(), profileId: profile.id } });
    toast(result.message);
  }
  function profileRouteReferences(profileId) {
    const entries = [];
    const uses = route => route?.profileId === profileId || route?.fallbacks?.some(item => item.profileId === profileId);
    if (uses(config.defaultRoute)) entries.push(t('默认路由'));
    for (const [agentId, route] of Object.entries(config.botRoutes)) if (uses(route))
      entries.push(agents.find(agent => agent.id === agentId)?.name ?? agentId);
    return entries;
  }
  function renderProfiles() {
    $('#add-model-profile').disabled = !config.providers.length;
    profilesRoot.replaceChildren();
    if (!config.profiles.length) {
      profilesRoot.append(empty(t('还没有模型档案'), t('每个档案绑定一个服务、模型和可用思考强度。')));
      return;
    }
    for (const profile of config.profiles) {
      const provider = providerById(profile.providerId), references = profileRouteReferences(profile.id);
      const test = iconButton('pulse', t('测试连接'));
      test.onclick = () => busy(test, () => testProfile(profile)).catch(error => toast(error.message, true));
      const more = menu(t('{0} 的更多操作', profile.name), [
        { label: t('编辑'), run: () => showProfile(profile) },
        { label: t('删除'), danger: true, disabled: references.length > 0, run: trigger => busy(trigger, async () => {
          if (!await confirmAction({ title: t('删除“{0}”？', profile.name), message: t('请先从 {0} 移除此档案。', references.join('、')), action: t('删除') })) return;
          config.profiles = config.profiles.filter(item => item.id !== profile.id); markDirty(); render();
        }) },
      ]);
      const effortText = profile.efforts.length ? profile.efforts.map(level => t(levelLabels[level])).join(' · ') : t('仅模型默认');
      profilesRoot.append(item({ icon: 'model', title: profile.name, badges: [badge(profile.model)],
        meta: [`${provider?.name ?? profile.providerId} · ${effortText}`, t('上下文 {0} · 摘要 {1}', formatTokenCount(profile.contextWindowTokens), formatTokenCount(profile.summaryThresholdTokens))],
        actions: [test, more] }));
    }
  }
  function renderDefaultRoute() {
    defaultRoot.replaceChildren();
    if (!config.profiles.length) {
      defaultRoot.append(empty(t('还没有可路由的模型'), t('添加模型档案后，设置所有 Bot 的默认模型。')));
      return;
    }
    if (!config.defaultRoute) config.defaultRoute = { profileId: config.profiles[0].id, effort: 'default', fallbacks: [] };
    routeEditor(defaultRoot, config.defaultRoute, route => { config.defaultRoute = route; markDirty(); renderDefaultRoute(); });
    defaultRoot.append(node('p', 'hint', t('仅在主模型未输出任何内容时，才会按顺序尝试备用模型。')));
  }
  function knownBots() {
    const result = new Map(agents.map(agent => [agent.id, agent]));
    for (const id of Object.keys(config.botRoutes)) if (!result.has(id)) result.set(id, { id, name: id, missing: true });
    return [...result.values()];
  }
  function renderBots() {
    botsRoot.replaceChildren();
    if (!config.profiles.length) {
      botsRoot.append(empty(t('先设置默认路由'), t('模型档案准备好后，才可为单个 Bot 覆盖路由。')));
      return;
    }
    const bots = knownBots();
    if (!bots.length) {
      botsRoot.append(empty(t('Host 未连接或尚无 Bot'), t('Host 连接后会在这里显示可覆盖的 Bot。')));
      return;
    }
    for (const bot of bots) {
      const override = config.botRoutes[bot.id], route = override ?? config.defaultRoute;
      const summarize = iconButton('archive', t('压缩上下文'));
      summarize.disabled = Boolean(bot.missing || bot.isRunning || bot.isGroup);
      summarize.onclick = () => busy(summarize, async () => {
        if (!await confirmAction({ title: t('压缩“{0}”的上下文？', bot.name),
          message: t('将使用此 Bot 当前路由的模型生成摘要。原始对话会保留，并会消耗模型 Token。'),
          action: t('开始压缩'), danger: false })) return;
        const result = await api(`/admin/api/agents/${encodeURIComponent(bot.id)}/summarize`, { method: 'POST' });
        toast(result.message ?? t('上下文已压缩'));
        await refresh();
      }).catch(error => toast(error.message, true));
      const edit = iconButton('edit', t('编辑 Bot 路由'));
      edit.onclick = () => showBotRoute(bot);
      botsRoot.append(item({ icon: 'share', title: bot.name,
        badges: [badge(override ? t('已覆盖') : t('使用默认'), override ? 'accent' : '')],
        meta: [routeDescription(route), bot.missing ? t('当前 Host 未报告此 Bot；保存时会保留其路由。') : ''], actions: [summarize, edit] }));
    }
  }
  function render() { renderProviders(); renderProfiles(); renderDefaultRoute(); renderBots(); }

  function showProvider(entry) {
    const current = entry ? clone(entry) : { id: uid('provider'), name: '', apiFormat: 'openai', baseUrl: '' };
    const { form: editForm, title, body, submit, dialog } = providerEditor;
    body.replaceChildren(); editForm.reset(); title.textContent = t(entry ? '编辑模型服务' : '添加模型服务');
    const name = formField(body, 'name', '名称'), apiFormat = formSelect(body, 'apiFormat', '接口格式');
    choice(apiFormat, formats, current.apiFormat);
    const baseUrl = formField(body, 'baseUrl', 'Base URL', 'url'), apiKey = formField(body, 'apiKey', 'API Key', 'password');
    name.required = true; baseUrl.required = true; name.value = current.name; baseUrl.value = current.baseUrl;
    apiKey.placeholder = providerHasKey(current) ? t('已保存，留空保留') : t('输入 API Key');
    apiFormat.onchange = () => { if (!baseUrl.value) baseUrl.value = defaultUrls[apiFormat.value]; };
    editForm.onsubmit = event => { event.preventDefault(); if (!editForm.reportValidity()) return; busy(submit, async () => {
      const next = { ...current, name: name.value.trim(), apiFormat: apiFormat.value, baseUrl: baseUrl.value.trim() };
      if (apiKey.value.trim()) pendingKeys.set(next.id, apiKey.value.trim());
      config.providers = [...config.providers.filter(provider => provider.id !== next.id), next]; markDirty(); dialog.close(); render();
    }).catch(error => toast(error.message, true)); };
    dialog.showModal(); name.focus();
  }
  function addEffortControls(parent, selected) {
    const group = node('fieldset', 'check-list'); group.append(node('legend', 'field', t('可用思考强度')));
    for (const level of levels) {
      const label = node('label', 'check'), input = document.createElement('input');
      input.type = 'checkbox'; input.name = `effort-${level}`; input.value = level; input.checked = selected.includes(level);
      label.append(input, node('span', '', t(levelLabels[level]))); group.append(label);
    }
    parent.append(group);
  }
  function showProfile(entry) {
    if (!config.providers.length) return;
    const current = entry ? clone(entry) : { id: uid('profile'), name: '', providerId: config.providers[0].id, model: '', efforts: [],
      contextWindowTokens: defaultContextWindowTokens, summaryThresholdTokens: defaultSummaryThresholdTokens };
    const { form: editForm, title, body, submit, dialog } = profileEditor;
    body.replaceChildren(); editForm.reset(); title.textContent = t(entry ? '编辑模型档案' : '添加模型档案');
    const name = formField(body, 'name', '名称'), providerId = formSelect(body, 'providerId', '模型服务');
    providerOptions(providerId, current.providerId);
    const modelField = node('label', 'field', t('模型 ID')), modelRow = node('div', 'inline-field'), model = document.createElement('input');
    model.name = 'model'; model.required = true; model.value = current.model; model.spellcheck = false;
    const list = document.createElement('datalist'); list.id = `model-catalog-${current.id}`; model.setAttribute('list', list.id);
    const catalog = node('button', 'btn btn-sm', t('同步模型')); catalog.type = 'button';
    const catalogSelect = document.createElement('select'); catalogSelect.hidden = true; catalogSelect.setAttribute('aria-label', t('从同步列表选择模型'));
    modelRow.append(model, catalog); modelField.append(modelRow, catalogSelect, list); body.append(modelField);
    addEffortControls(body, current.efforts ?? []);
    const contextFields = node('div', 'field-grid');
    const capacity = formField(contextFields, 'contextWindowTokens', '上下文容量'), threshold = formField(contextFields, 'summaryThresholdTokens', '摘要阈值');
    capacity.placeholder = t('未知'); threshold.placeholder = t('原策略'); capacity.value = formatTokenCount(current.contextWindowTokens); threshold.value = formatTokenCount(current.summaryThresholdTokens);
    body.append(contextFields, node('p', 'hint', t('支持 1M、400K。同步后会自动填入上下文容量和摘要阈值。')));
    let catalogModels = new Map();
    const applyCatalogModel = (modelId, { onlyMissingContext = false } = {}) => {
      const entry = catalogModels.get(modelId);
      const values = entry?.efforts;
      if (!values) return;
      for (const level of levels) editForm.elements[`effort-${level}`].checked = values.includes(level);
      const currentCapacity = parseTokenCount(capacity.value), currentThreshold = parseTokenCount(threshold.value);
      if (Number.isSafeInteger(entry.contextWindowTokens) && entry.contextWindowTokens > 0 &&
        (!onlyMissingContext || !currentCapacity || !currentThreshold)) {
        capacity.value = formatTokenCount(entry.contextWindowTokens);
        threshold.value = formatTokenCount(entry.summaryThresholdTokens ?? 0);
      }
    };
    model.onchange = () => applyCatalogModel(model.value);
    providerId.onchange = () => { catalogModels = new Map(); catalogSelect.hidden = true; catalogSelect.replaceChildren(); list.replaceChildren(); };
    catalogSelect.onchange = () => {
      if (!catalogSelect.value) return;
      model.value = catalogSelect.value; applyCatalogModel(model.value);
    };
    catalog.onclick = () => busy(catalog, async () => {
      const provider = providerById(providerId.value);
      if (!provider) throw new Error(t('请先选择模型服务。'));
      const result = await api('/admin/api/model/catalog', { method: 'POST', body: { provider: serializedProvider(provider) } });
      catalogModels = new Map(result.models.map(candidate => [candidate.id, candidate]));
      list.replaceChildren(...result.models.map(candidate => new Option(candidate.id, candidate.id)));
      catalogSelect.replaceChildren(new Option(t('从同步列表选择模型'), ''), ...result.models.map(candidate => new Option(candidate.id, candidate.id)));
      catalogSelect.value = result.models.some(candidate => candidate.id === model.value) ? model.value : '';
      if (catalogSelect.value) applyCatalogModel(model.value, { onlyMissingContext: true });
      catalogSelect.hidden = false; toast(t('已同步 {0} 个模型', result.models.length));
    }).catch(error => toast(error.message, true));
    editForm.onsubmit = event => { event.preventDefault(); if (!editForm.reportValidity()) return; busy(submit, async () => {
      const contextWindowTokens = parseTokenCount(capacity.value), summaryThresholdTokens = parseTokenCount(threshold.value);
      if (!Number.isFinite(contextWindowTokens) || !Number.isFinite(summaryThresholdTokens)) throw new Error(t('请输入 0–100M 的整数 Token 数，如 1M、400K。'));
      if (summaryThresholdTokens && (!contextWindowTokens || summaryThresholdTokens >= contextWindowTokens)) throw new Error(t('摘要阈值必须小于上下文容量。'));
      const next = { ...current, name: name.value.trim(), providerId: providerId.value, model: model.value.trim(),
        efforts: levels.filter(level => editForm.elements[`effort-${level}`].checked), contextWindowTokens, summaryThresholdTokens };
      config.profiles = [...config.profiles.filter(profile => profile.id !== next.id), next];
      if (!config.defaultRoute) config.defaultRoute = { profileId: next.id, effort: 'default', fallbacks: [] };
      markDirty(); dialog.close(); render();
    }).catch(error => toast(error.message, true)); };
    dialog.showModal(); name.focus();
  }
  function showBotRoute(bot) {
    const { form: editForm, title, body, submit, dialog } = botEditor;
    let useDefault = !config.botRoutes[bot.id], route = routeCopy(config.botRoutes[bot.id] ?? config.defaultRoute);
    body.replaceChildren(); editForm.reset(); title.textContent = bot.name;
    const toggleLine = node('label', 'check'), toggle = document.createElement('input');
    toggle.type = 'checkbox'; toggle.checked = useDefault; toggleLine.append(toggle, node('span', '', t('使用默认路由'))); body.append(toggleLine);
    const routeRoot = node('div', 'dialog-group'); body.append(routeRoot);
    const draw = () => {
      routeRoot.replaceChildren(); routeRoot.hidden = useDefault;
      if (!useDefault) routeEditor(routeRoot, route, value => { route = value; draw(); });
    };
    toggle.onchange = () => { useDefault = toggle.checked; if (!useDefault && !route) route = routeCopy(config.defaultRoute); draw(); };
    draw();
    editForm.onsubmit = event => { event.preventDefault(); busy(submit, async () => {
      if (useDefault) delete config.botRoutes[bot.id]; else config.botRoutes[bot.id] = routeCopy(route);
      markDirty(); dialog.close(); renderBots();
    }).catch(error => toast(error.message, true)); };
    dialog.showModal();
  }
  function updateAgents(next) {
    const entries = (next ?? []).map(agent => ({ id: agent.id, name: agent.name, isGroup: Boolean(agent.isGroup), isRunning: Boolean(agent.isRunning) }))
      .filter(agent => typeof agent.id === 'string' && typeof agent.name === 'string');
    const signature = JSON.stringify(entries);
    if (signature === agentSignature) return;
    agents = entries; agentSignature = signature;
    if (loaded) renderBots();
  }
  function showError(error) { $('#model-error').textContent = error.message; $('#model-error').hidden = false; }
  function setIcon(target, name, label) {
    const source = iconButton(name, t(label)); target.innerHTML = source.innerHTML; target.title = t(label);
  }

  setIcon($('#add-model-provider'), 'plus', '添加模型服务');
  setIcon($('#add-model-profile'), 'plus', '添加模型档案');
  $('#add-model-provider').onclick = () => showProvider();
  $('#add-model-profile').onclick = () => showProfile();
  setIcon($('#refresh-model-bots'), 'refresh', '刷新 Bot');
  $('#refresh-model-bots').onclick = () => busy($('#refresh-model-bots'), refresh).catch(error => toast(error.message, true));
  setIcon($('#refresh-routing'), 'refresh', '刷新');
  $('#refresh-routing').onclick = () => routingLog.load();
  form.onsubmit = event => { event.preventDefault(); $('#model-error').hidden = true; busy(event.submitter, async () => {
    try {
      if (legacyAdaptive && !await confirmAction({
        title: t('迁移旧版模型路由？'),
        message: t('保存后会改为按 Bot 选择模型，旧版按任务难度路由和 Jev 选择将不再生效。'),
        action: t('迁移并保存'),
      })) return;
      const result = await api('/admin/api/model', { method: 'PUT', body: input() });
      legacyRouting = false; legacyAdaptive = false;
      $('#legacy-routing-notice').hidden = true;
      setConfig(result); toast(t('配置已保存')); await refresh();
    } catch (error) { showError(error); }
  }); };

  return {
    status(next, isActive) {
      active = isActive; updateAgents(next.host?.agents);
      if (!loaded) setConfig(next.model);
      else if (!dirty) $('#model-apply-title').textContent = applyText(next.model);
      if (active) routingLog.load();
    },
    async load() {
      if (!dirty) setConfig(await api('/admin/api/model'));
      if (active) await routingLog.load();
    },
    reset() { config = emptyRouting(); pendingKeys = new Map(); loaded = false; dirty = false; active = false; agents = [];
      agentSignature = ''; legacyRouting = false; legacyAdaptive = false; $('#legacy-routing-notice').hidden = true; form.reset(); },
  };
}
