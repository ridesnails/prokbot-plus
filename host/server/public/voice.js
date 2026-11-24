import { $, node, item, empty, iconButton, dialog as wireDialog } from './ui.js';
import { t, html, locale } from './i18n.js';
import { clientId } from './ids.js';

export function createVoiceEditor({ api, toast, busy }) {
  const form = $('#voice-form'), fields = form.elements, button = form.querySelector('[type=submit]');
  const error = $('#voice-error'), preview = $('#voice-preview'), player = $('#voice-audio');
  let loaded = false, saved, audioUrl, dirty = false, catalogPage = 0;
  const library = $('#voice-library'), libraryLoad = $('#voice-library-load'), libraryNext = $('#voice-library-next');
  const candidatesRoot = $('#voice-candidates');
  let candidates = [];
  $('#voice-library-language').value = locale.startsWith('zh') ? 'zh' : 'en';
  $('#voice-preview-text').value = t('你好，我们可以开始语音聊天了。');
  function errorText(value) {
    const messages = {
      'Voice chat is not configured': '请启用语音通话', 'Voice endpoint is required': '请输入接口地址',
      'Invalid voice endpoint': '语音接口地址无效',
      'Fish Audio API key is required': '请输入 Fish Audio API Key',
      'Choose a Fish voice or enter a reference ID': '请选择音色或填写音色 ID',
      'Could not load voice library': '无法读取音色，可手动填写音色 ID',
      'A Fish speech key with the same service origin is required': '请先保存同服务的 Fish 识别密钥',
      'Speech API key reuse requires Fish Audio': '仅 Fish Audio 支持复用识别服务 API Key',
      'Voice model is required': '请输入语音模型', 'Voice is required': '请输入音色',
      'Voice speed must be 0.5–2': '语速必须在 0.5 到 2 之间',
      'Invalid voice latency': '语音延迟配置无效',
      'Voice timeout must be 1000–120000 ms': '语音超时必须在 1000 到 120000 毫秒之间',
      'Unknown voice provider': '不支持的语音合成服务',
      'Invalid voice selection': '自动选音色配置无效',
      'Invalid automatic voice selection value': '自动选音色开关值无效',
      'Too many voice candidates': '候选音色数量过多',
      'Invalid voice candidate': '候选音色格式无效',
      'Invalid voice candidate ID': '候选音色 ID 无效或重复',
      'Invalid voice candidate name': '请输入有效的候选音色名称',
      'Voice candidate does not match its provider': '候选音色与所选合成服务不匹配',
      'Invalid voice candidate keywords': '候选音色关键词无效或过多',
      'Invalid voice candidate languages': '候选音色语言代码无效（请填写如 zh、en）',
      'Voice service API credit is insufficient': '语音服务额度不足',
      'Voice service rejected the API key': '语音服务拒绝了 API Key',
      'Voice synthesis timed out': '语音合成超时', 'Could not reach the voice service': '无法连接语音服务',
    };
    return t(messages[value] ?? value);
  }
  function controls() {
    const fish = fields.provider.value === 'fish';
    $('#voice-reference-row').hidden = !fish; $('#voice-name-row').hidden = fish;
    $('#voice-library-row').hidden = !fish;
    fields.referenceId.required = fish && fields.enabled.checked;
    $('#voice-reuse-row').hidden = !fish;
    $('#voice-key-row').hidden = fish && fields.reuseKey.checked;
    $('#voice-clear-row').hidden = $('#voice-key-row').hidden || !saved?.tts.hasApiKey;
    $('#voice-candidate-add').disabled = !loaded;
    preview.disabled = !loaded || !saved?.enabled || dirty;
    button.disabled = !loaded;
  }
  function render(value) {
    saved = value; loaded = true; dirty = false; form.reset();
    $('#voice-preview-text').value = t('你好，我们可以开始语音聊天了。');
    fields.enabled.checked = value.enabled;
    for (const name of ['provider', 'endpoint', 'model', 'referenceId', 'voice', 'speed']) fields[name].value = value.tts[name];
    fields.reuseKey.checked = value.tts.apiKeySource === 'speech';
    fields.selectionEnabled.checked = value.selection?.enabled !== false;
    candidates = structuredClone(value.selection?.candidates ?? []);
    fields.apiKey.placeholder = t(value.tts.hasApiKey ? '已保存，留空保留' : '输入 API Key');
    $('#voice-asr-status').textContent = value.asr.configured ? t('使用上方识别服务') : t('请先启用识别服务');
    error.hidden = true; renderCandidates(); controls();
  }
  function candidateVoice(entry) { return entry.provider === 'fish' ? entry.referenceId : entry.voice; }
  function candidateMeta(entry) {
    const details = [entry.provider === 'fish' ? 'Fish Audio' : t('OpenAI 兼容')];
    if (entry.languages?.length) details.push(entry.languages.join(', '));
    if (entry.keywords?.length) details.push(t('关键词：{0}', entry.keywords.join('、')));
    return details.join(' · ');
  }
  function renderCandidates() {
    candidatesRoot.replaceChildren();
    if (!candidates.length) {
      candidatesRoot.append(empty(t('还没有候选音色'), t('添加候选音色后，Host 会按 Bot 的名称、标题和说明匹配；没有匹配时使用默认音色。')));
      return;
    }
    for (const entry of candidates) {
      const edit = iconButton('edit', t('编辑'), () => showCandidate(entry));
      const remove = iconButton('close', t('删除'), () => {
        candidates = candidates.filter(candidate => candidate.id !== entry.id); dirty = true; renderCandidates(); controls();
      });
      candidatesRoot.append(item({ icon: 'voice', title: entry.name, badges: [node('span', 'badge', candidateVoice(entry))],
        meta: [candidateMeta(entry)], actions: [edit, remove] }));
    }
  }
  function showCandidate(entry) {
    const current = entry ? structuredClone(entry) : { id: clientId('voice'), name: '', provider: fields.provider.value,
      referenceId: '', voice: '', keywords: [], languages: [] };
    const dialog = document.createElement('dialog'); dialog.className = 'dialog';
    const providerOptions = '<option value="fish">Fish Audio</option><option value="openai">OpenAI 兼容</option>';
    dialog.innerHTML = html(`<form><div class="dialog-head"><h2>${entry ? '编辑候选音色' : '添加候选音色'}</h2><button type="button" data-close class="icon-btn" aria-label="关闭">${iconButton('close', t('关闭')).innerHTML}</button></div>
      <div class="dialog-body"><label class="field">名称<input name="name" maxlength="120" required /></label>
      <label class="field">合成服务<select name="provider">${providerOptions}</select></label>
      <label id="candidate-reference" class="field">音色 ID<input name="referenceId" maxlength="200" /></label>
      <label id="candidate-voice" class="field">音色<input name="voice" maxlength="200" /></label>
      <label class="field">关键词<input name="keywords" maxlength="1000" placeholder="用逗号或顿号分隔，例如：研究、分析、research" /></label>
      <label class="field">语言<input name="languages" maxlength="160" placeholder="用逗号或顿号分隔，例如：zh、en" /></label>
      <p class="hint">仅按 Bot 的名称、标题和说明匹配；关键词不命中时保留默认音色。</p>
      <p class="error" data-candidate-error role="alert" hidden></p></div>
      <div class="dialog-foot"><button type="button" data-close class="btn">取消</button><button type="submit" class="btn btn-primary">保存</button></div></form>`);
    $('[data-panel=speech]').append(dialog);
    const candidateForm = $('form', dialog), candidateFields = candidateForm.elements;
    const candidateError = $('[data-candidate-error]', dialog);
    for (const name of ['name', 'provider', 'referenceId', 'voice']) candidateFields[name].value = current[name] ?? '';
    candidateFields.keywords.value = (current.keywords ?? []).join(', '); candidateFields.languages.value = (current.languages ?? []).join(', ');
    const showProviderFields = () => {
      $('#candidate-reference', dialog).hidden = candidateFields.provider.value !== 'fish';
      $('#candidate-voice', dialog).hidden = candidateFields.provider.value === 'fish';
    };
    candidateFields.provider.onchange = showProviderFields; showProviderFields();
    candidateForm.addEventListener('input', () => { candidateError.hidden = true; });
    wireDialog(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    candidateForm.onsubmit = event => {
      event.preventDefault();
      candidateError.hidden = true;
      const split = value => value.split(/[,，、;；]/).map(item => item.trim()).filter(Boolean);
      const provider = candidateFields.provider.value;
      const next = { id: current.id, name: candidateFields.name.value.trim(), provider,
        referenceId: provider === 'fish' ? candidateFields.referenceId.value.trim() : '',
        voice: provider === 'openai' ? candidateFields.voice.value.trim() : '',
        keywords: split(candidateFields.keywords.value), languages: split(candidateFields.languages.value) };
      if (!next.name || !next.keywords.length || (next.provider === 'fish' ? !next.referenceId : !next.voice)) {
        candidateError.textContent = t('请填写名称、至少一个关键词，以及对应服务的音色。'); candidateError.hidden = false; return;
      }
      candidates = [...candidates.filter(candidate => candidate.id !== next.id), next]; dirty = true; renderCandidates(); controls(); dialog.close();
    };
    dialog.showModal(); candidateFields.name.focus();
  }
  function clearAudio() { player.pause(); player.removeAttribute('src'); player.hidden = true; if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; }
  async function load() {
    if (loaded) return;
    try { render(await api('/admin/api/voice')); }
    catch (e) { error.textContent = errorText(e.message); error.hidden = false; }
  }
  fields.provider.addEventListener('change', () => {
    fields.endpoint.value = fields.provider.value === 'fish' ? 'https://api.fish.audio/v1/tts' : '';
    fields.model.value = ''; fields.voice.value = ''; fields.referenceId.value = ''; fields.apiKey.value = '';
    fields.reuseKey.checked = false; controls();
  });
  fields.reuseKey.addEventListener('change', controls);
  const dirtyInput = event => { if (!['voice-preview-text', 'voice-library-search', 'voice-library-language', 'voice-library'].includes(event.target.id)) { dirty = true; controls(); } };
  form.addEventListener('input', dirtyInput);
  form.addEventListener('change', dirtyInput);
  async function loadVoices(page) {
    error.hidden = true;
    try {
      const data = await api('/admin/api/voice/voices', { method: 'POST', body: {
        page, language: $('#voice-library-language').value, title: $('#voice-library-search').value.trim(),
        tts: { endpoint: fields.endpoint.value.trim(), apiKey: fields.apiKey.value.trim(),
          apiKeySource: fields.reuseKey.checked ? 'speech' : 'own', clearApiKey: fields.clearApiKey.checked },
      } });
      catalogPage = data.page;
      library.replaceChildren(new Option(t('选择音色'), ''), ...data.voices.map(voice => new Option(voice.name, voice.id)));
      library.value = fields.referenceId.value;
      $('#voice-library-results').hidden = false; libraryNext.hidden = !data.hasMore;
    } catch (e) { error.textContent = errorText(e.message); error.hidden = false; }
  }
  libraryLoad.addEventListener('click', () => void busy(libraryLoad, () => loadVoices(1)));
  libraryNext.addEventListener('click', () => void busy(libraryNext, () => loadVoices(catalogPage + 1)));
  library.addEventListener('change', () => {
    if (!library.value) return;
    fields.referenceId.value = library.value; dirty = true; controls();
  });
  $('#voice-candidate-add').addEventListener('click', () => showCandidate());
  form.addEventListener('submit', event => {
    event.preventDefault();
    void busy(button, async () => {
      try {
        const tts = Object.fromEntries(['provider', 'endpoint', 'model', 'referenceId', 'voice', 'apiKey'].map(name => [name, fields[name].value.trim()]));
        Object.assign(tts, { speed: Number(fields.speed.value), apiKeySource: fields.provider.value === 'fish' && fields.reuseKey.checked ? 'speech' : 'own', clearApiKey: fields.clearApiKey.checked });
        render(await api('/admin/api/voice', { method: 'PUT', body: { enabled: fields.enabled.checked, tts,
          selection: { enabled: fields.selectionEnabled.checked, candidates } } }));
        toast(t('配置已保存')); clearAudio();
      } catch (e) { error.textContent = errorText(e.message); error.hidden = false; }
    });
  });
  preview.addEventListener('click', () => void busy(preview, async () => {
    clearAudio(); error.hidden = true;
    try {
      const audio = await api('/admin/api/voice/test', { method: 'POST',
        binary: true, body: { text: $('#voice-preview-text').value.trim() } });
      audioUrl = URL.createObjectURL(audio); player.src = audioUrl; player.hidden = false;
      await player.play().catch(() => {});
    } catch (e) { if (e.name !== 'AbortError') { error.textContent = errorText(e.message); error.hidden = false; } }
  }));
  return { load, reset() { loaded = false; saved = undefined; candidates = []; clearAudio(); form.reset(); candidatesRoot.replaceChildren(); controls(); } };
}
