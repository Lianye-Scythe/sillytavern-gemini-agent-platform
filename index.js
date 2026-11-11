import { SECRET_KEYS, secret_state, writeSecret } from '../../../secrets.js';
import { MODELS, validModel, validProject, extractProject, safeError, prepareRequest, testRequest } from './core.js';

const NAME = 'gemini_global';
const SOURCE = 'gemini-agent-platform';
const context = () => SillyTavern.getContext();
let busy = false;
let controller;
let syncingSource = false;

function settings() {
    const all = context().extensionSettings;
    all[NAME] ??= {};
    const value = all[NAME];
    value.enabled ??= true;
    value.model ??= 'gemini-3.8-flash';
    value.project ??= '';
    value.customModels ??= [];
    value.platformActive ??= false;
    return value;
}

const VERTEX_FIELDS = ['vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id', 'vertexai_model'];

function syncSourceUi() {
    const original = document.getElementById('chat_completion_source');
    const facade = document.getElementById('gemini-platform-source');
    if (!facade) return;
    const active = settings().platformActive && original.value === 'vertexai';
    facade.value = active ? SOURCE : original.value;
    document.getElementById('vertexai_form').classList.toggle('gg-platform-active', active);
    document.getElementById('gemini-global').hidden = !active;
}

function updateNativeFields() {
    const value = context().chatCompletionSettings;
    $('#vertexai_auth_mode').val(value.vertexai_auth_mode).trigger('change');
    $('#vertexai_region').val(value.vertexai_region).trigger('input');
    $('#vertexai_express_project_id').val(value.vertexai_express_project_id).trigger('input');
    $('#model_vertexai_select').val(value.vertexai_model).trigger('change');
}

function selectSource(source) {
    const value = settings();
    const native = context().chatCompletionSettings;
    if (source === SOURCE) {
        if (!value.platformActive) {
            value.previousVertex = Object.fromEntries(VERTEX_FIELDS.map(key => [key, native[key]]));
        }
        value.platformActive = true;
        Object.assign(native, {
            vertexai_auth_mode: 'express', vertexai_region: 'global',
            vertexai_express_project_id: value.project, vertexai_model: value.model,
        });
    } else {
        const previous = value.previousVertex;
        const restore = value.platformActive && previous;
        value.platformActive = false;
        if (restore) {
            for (const key of VERTEX_FIELDS) {
                if (Object.hasOwn(previous, key)) native[key] = previous[key];
            }
        }
    }
    syncingSource = true;
    try {
        updateNativeFields();
        $('#chat_completion_source').val(source === SOURCE ? 'vertexai' : source).trigger('change');
    } finally {
        syncingSource = false;
    }
    syncSourceUi();
    context().saveSettingsDebounced();
}

function installSourceSelector() {
    // Keep ST's canonical selector and source enum intact for its prompt/stream
    // pipeline. A visible selector adds our source and maps it to the native backend.
    const original = document.getElementById('chat_completion_source');
    const facade = original.cloneNode(true);
    facade.id = 'gemini-platform-source';
    facade.setAttribute('aria-label', '聊天補全來源');
    const option = new Option('Gemini Agent Platform', SOURCE);
    const vertexOption = [...facade.options].find(o => o.value === 'vertexai');
    if (vertexOption) vertexOption.before(option);
    else facade.add(option);
    original.after(facade);
    original.style.setProperty('display', 'none', 'important');
    original.setAttribute('aria-hidden', 'true');
    facade.addEventListener('change', () => selectSource(facade.value));
    $('#chat_completion_source').on('change.geminiGlobal', () => {
        if (syncingSource) return;
        const native = context().chatCompletionSettings;
        if (original.value !== 'vertexai' || native.vertexai_auth_mode !== 'express') settings().platformActive = false;
        syncSourceUi();
    });
    syncSourceUi();
}

function status(message, state = '') {
    const el = document.getElementById('gg-status');
    el.textContent = safeError(message);
    el.dataset.state = state;
}

function addModels() {
    const native = document.getElementById('model_vertexai_select');
    const own = document.getElementById('gg-model');
    const current = native.value || context().chatCompletionSettings.vertexai_model;
    let group = native.querySelector('[data-gemini-global]');
    if (!group) {
        group = document.createElement('optgroup');
        group.label = 'Gemini Global';
        group.dataset.geminiGlobal = 'true';
        native.prepend(group);
    }
    for (const model of [...MODELS, ...settings().customModels]) {
        if (!validModel(model)) continue;
        if (![...native.options].some(option => option.value === model)) group.append(new Option(model, model));
        if (![...own.options].some(option => option.value === model)) own.add(new Option(model, model));
    }
    if ([...native.options].some(option => option.value === current)) native.value = current;
    own.value = settings().model;
}

function applyConnection() {
    const value = settings();
    const project = document.getElementById('gg-project').value.trim();
    if (!validProject(project)) throw new Error('請填入有效的 Project ID 或 Project Number，或留空以自動偵測。');
    value.project = project;
    value.model = document.getElementById('gg-model').value;
    value.enabled = true;
    document.getElementById('gg-enabled').checked = true;
    $('#main_api').val('openai').trigger('change');
    addModels();
    selectSource(SOURCE);
    context().saveSettingsDebounced();
}

async function request(data, signal) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: context().getRequestHeaders(),
        body: JSON.stringify(data),
        signal,
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = {}; }
    if (!response.ok || body.error) {
        const detail = body.error?.message || body.message || text || `HTTP ${response.status}`;
        const error = new Error(safeError(detail));
        error.project = extractProject(text);
        throw error;
    }
    return body;
}

async function discoverProject(signal) {
    // A deliberately nonexistent model gets a resource-path error without generating tokens.
    try {
        await request(testRequest('gemini-global-project-discovery'), signal);
    } catch (error) {
        if (error.project) return error.project;
        if (error.name === 'AbortError') throw error;
        throw new Error(`無法自動取得 Project ID，請手動填寫。${error.message}`);
    }
    throw new Error('Google 未回傳 Project ID，請手動填寫。');
}

async function connect() {
    if (busy) return;
    busy = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const input = document.getElementById('gg-key');
    const newKey = input.value.trim();
    const button = document.getElementById('gg-connect');
    button.disabled = true;
    document.getElementById('gg-cancel').hidden = false;
    try {
        const model = document.getElementById('gg-model').value;
        if (!validModel(model)) throw new Error('請選擇有效模型。');
        const manual = document.getElementById('gg-project').value.trim();
        if (manual && !validProject(manual)) throw new Error('Project ID 或 Project Number 格式不正確。');
        if (newKey) {
            status('正在儲存 API Key…');
            const id = await writeSecret(SECRET_KEYS.VERTEXAI, newKey, 'Gemini Global');
            if (!id) throw new Error('API Key 儲存失敗，請檢查酒館連線。');
            input.value = '';
        } else if (!secret_state[SECRET_KEYS.VERTEXAI]) {
            throw new Error('請先輸入 API Key。');
        }
        // A newly supplied key may belong to a different project. Detect again unless
        // the project field was explicitly edited by the user.
        const mustDiscover = !manual || (newKey && !document.getElementById('gg-project').dataset.manual);
        if (mustDiscover) {
            status('正在自動取得 Project ID…');
            const project = await discoverProject(controller.signal);
            document.getElementById('gg-project').value = project;
            delete document.getElementById('gg-project').dataset.manual;
        }
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        applyConnection();
        status(`正在測試 ${model}（global）…`);
        const body = await request(testRequest(model, settings().project), controller.signal);
        const reply = body.choices?.[0]?.message?.content;
        if (!reply?.trim()) throw new Error('API 已回應，但沒有文字內容；可稍後重試。');
        status(`${model} 連線成功 · global · ${reply.trim().slice(0, 80)}`, 'success');
        $('#api_button_openai').trigger('click');
    } catch (error) {
        status(error.name === 'AbortError' ? '測試已取消或超過 120 秒；設定已保留，可重試。' : error.message, 'error');
    } finally {
        clearTimeout(timeout);
        busy = false;
        button.disabled = false;
        document.getElementById('gg-cancel').hidden = true;
        controller = undefined;
    }
}

function init() {
    const form = document.getElementById('vertexai_form');
    if (!form || !document.getElementById('vertexai_express_project_id')) {
        toastr.error('Gemini Global 需要支援 Vertex AI Project ID 的酒館版本（1.13.1 以上）。');
        return;
    }
    if (document.getElementById('gemini-global')) return;
    const panel = document.createElement('section');
    panel.id = 'gemini-global';
    panel.innerHTML = `
        <h4>Gemini Agent Platform · API Key</h4>
        <label class="checkbox_label"><input id="gg-enabled" type="checkbox">啟用最新模型的 global 連線</label>
        <p class="gg-hint">輸入 Google Cloud API Key 即可使用，不需要服務帳號 JSON。</p>
        <label for="gg-key">API Key</label>
        <input id="gg-key" class="text_pole" type="password" autocomplete="new-password" placeholder="輸入新 Key；留空則使用已儲存的 Vertex AI Key">
        <label for="gg-model">模型</label>
        <select id="gg-model" class="text_pole"></select>
        <label for="gg-project">Project ID / Project Number（可自動取得）</label>
        <input id="gg-project" class="text_pole" type="text" autocomplete="off" placeholder="留空，儲存時自動偵測">
        <div class="gg-actions">
            <button id="gg-connect" class="menu_button" type="button">儲存並測試連線</button>
            <button id="gg-cancel" class="menu_button" type="button" hidden>取消測試</button>
        </div>
        <p id="gg-status" role="status" aria-live="polite">準備就緒。選擇模型後按「儲存並測試連線」。</p>
        <details><summary>自訂模型</summary>
            <div class="gg-actions"><input id="gg-custom" class="text_pole" aria-label="自訂 Gemini 模型 ID" placeholder="gemini-…">
            <button id="gg-add" class="menu_button" type="button">加入模型</button></div>
        </details>`;
    form.prepend(panel);
    const value = settings();
    document.getElementById('gg-enabled').checked = value.enabled;
    document.getElementById('gg-project').value = value.project;
    addModels();
    installSourceSelector();
    document.getElementById('gg-connect').addEventListener('click', connect);
    document.getElementById('gg-cancel').addEventListener('click', () => controller?.abort());
    document.getElementById('gg-project').addEventListener('input', event => {
        event.target.dataset.manual = 'true';
    });
    document.getElementById('gg-enabled').addEventListener('change', event => {
        settings().enabled = event.target.checked;
        context().saveSettingsDebounced();
    });
    document.getElementById('gg-model').addEventListener('change', event => {
        settings().model = event.target.value;
        $('#model_vertexai_select').val(event.target.value).trigger('change');
        context().saveSettingsDebounced();
    });
    $('#model_vertexai_select').on('change.geminiGlobal', event => {
        const model = event.target.value;
        if (settings().platformActive && [...MODELS, ...settings().customModels].includes(model)) {
            settings().model = model;
            document.getElementById('gg-model').value = model;
        }
    });
    document.getElementById('gg-add').addEventListener('click', () => {
        const model = document.getElementById('gg-custom').value.trim();
        if (!validModel(model)) return status('模型 ID 必須以 gemini- 開頭，且只能包含英數字、點、底線與連字號。', 'error');
        if (!settings().customModels.includes(model) && !MODELS.includes(model)) settings().customModels.push(model);
        settings().model = model;
        addModels();
        $('#model_vertexai_select').val(model).trigger('change');
        document.getElementById('gg-custom').value = '';
        context().saveSettingsDebounced();
        status(`已加入 ${model}。是否可用仍取決於 Google 與專案權限。`);
    });
    const ctx = context();
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, data => {
        const project = context().chatCompletionSettings.vertexai_express_project_id || settings().project;
        try {
            prepareRequest(data, { ...settings(), enabled: settings().enabled && settings().platformActive, project });
        } catch (error) {
            status(error.message, 'error');
            throw error;
        }
    });
}

$(init);
