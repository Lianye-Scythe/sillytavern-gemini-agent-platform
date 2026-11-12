import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { CORE_VERSION, MODELS, validModel, validProject, extractProject, safeError, prepareRequest, testRequest } from './core.v1.0.5.js';

const RUNTIME_VERSION = '1.0.5';
const NAME = 'gemini_global';
const SOURCE = 'gemini-agent-platform';
const CONNECTION_META = 'gemini_agent_platform';
const context = () => SillyTavern.getContext();
let projectPromise;
let syncingSource = false;
let nativeKeyRow;
let nativeKeyAnchor;
let applyingPreset = false;
let loadingProfile;
let previousProxy;

function isPlatformActive() {
    const ctx = context();
    return ctx.mainApi === 'openai' && settings().platformActive && ctx.chatCompletionSettings.chat_completion_source === 'vertexai';
}

function normalizeProfile(profile) {
    if (profile?.[CONNECTION_META]?.source !== SOURCE || profile.exclude?.includes('api')) return;
    profile.api = SOURCE;
    if (profile.exclude?.includes('proxy')) delete profile.proxy;
    else profile.proxy = 'None';
    if (profile.exclude?.includes('api-url')) delete profile['api-url'];
    else profile['api-url'] = 'global';
}

function installProfileCommands() {
    const ctx = context();
    const commands = ctx.SlashCommandParser?.commands;
    const map = ctx.CONNECT_API_MAP;
    if (!commands?.api || !commands.proxy || !map?.vertexai) return;
    // Profiles and the native request service recognize our identity, while
    // generation still uses ST's canonical Vertex prompt/response converters.
    map[SOURCE] = { ...map.vertexai };
    const api = commands.api.callback;
    commands.api.callback = async function (args, text) {
        const target = String(text ?? '').trim().toLowerCase();
        if (!target && isPlatformActive()) return SOURCE;
        if (target === SOURCE) {
            await api.call(this, args, 'vertexai');
            selectSource(SOURCE);
            return SOURCE;
        }
        if (target && isPlatformActive()) selectSource('vertexai');
        return api.call(this, args, text);
    };
    const choices = commands.api.unnamedArgumentList?.[0]?.enumList;
    if (choices && ctx.SlashCommandEnumValue && !choices.some(choice => choice.value === SOURCE)) {
        choices.push(new ctx.SlashCommandEnumValue(SOURCE, 'Gemini Agent Platform'));
    }
    const proxy = commands.proxy.callback;
    commands.proxy.callback = function (args, text) {
        if (isPlatformActive()) {
            useDirectConnection();
            return 'None';
        }
        return proxy.call(this, args, text);
    };
    for (const profile of ctx.extensionSettings.connectionManager?.profiles ?? []) normalizeProfile(profile);
    ctx.saveSettingsDebounced();

    // ConnectionManagerRequestService bypasses the usual generation event. Carry
    // profile identity to its final send step so preset merging cannot restore a proxy.
    const service = ctx.ConnectionManagerRequestService;
    const chat = ctx.ChatCompletionService;
    if (!service || !chat) return;
    const sendProfile = service.sendRequest;
    service.sendRequest = function (id, prompt, maxTokens, custom, overrides = {}) {
        const profile = this.getProfile(id);
        const saved = profile?.[CONNECTION_META];
        if (saved?.source === SOURCE) {
            overrides = { ...overrides, chat_completion_source: 'vertexai', [CONNECTION_META]: saved };
        }
        return sendProfile.call(this, id, prompt, maxTokens, custom, overrides);
    };
    const sendChat = chat.sendRequest;
    chat.sendRequest = function (data, ...args) {
        const saved = data[CONNECTION_META];
        if (saved?.source === SOURCE) {
            prepareRequest(data, { ...saved, enabled: true, customModels: settings().customModels });
            delete data[CONNECTION_META];
        }
        return sendChat.call(this, data, ...args);
    };
}

function useDirectConnection() {
    const native = context().chatCompletionSettings;
    const select = document.getElementById('openai_proxy_preset');
    if (native.reverse_proxy || native.proxy_password) {
        previousProxy = { url: native.reverse_proxy, password: native.proxy_password };
        if (select?.value && select.value !== 'None') settings().previousProxyPreset = select.value;
    }
    if (select && select.value !== 'None' && [...select.options].some(option => option.value === 'None')) {
        $(select).val('None').trigger('change');
    }
    native.reverse_proxy = '';
    native.proxy_password = '';
    $('#openai_reverse_proxy,#openai_proxy_access_key').val('');
    $('.reverse_proxy_warning').hide();
}

function restoreProxy() {
    const preset = settings().previousProxyPreset;
    const select = document.getElementById('openai_proxy_preset');
    if (preset && select && [...select.options].some(option => option.value === preset)) $(select).val(preset).trigger('change');
    if (previousProxy) {
        $('#openai_reverse_proxy').val(previousProxy.url).trigger('input');
        $('#openai_proxy_access_key').val(previousProxy.password).trigger('input');
        previousProxy = undefined;
    }
    delete settings().previousProxyPreset;
}

function connectionSnapshot() {
    const value = settings();
    return { source: SOURCE, model: value.model, project: value.project };
}

function syncPresetIdentity() {
    const native = context().chatCompletionSettings;
    native.extensions ??= {};
    if (settings().platformActive && native.chat_completion_source === 'vertexai') {
        native.extensions[CONNECTION_META] = connectionSnapshot();
    } else {
        delete native.extensions[CONNECTION_META];
    }
}

function restoreConnection(saved) {
    if (saved?.source !== SOURCE) return false;
    const value = settings();
    if (validModel(saved.model)) value.model = saved.model;
    value.project = validProject(saved.project) ? saved.project : '';
    if (!MODELS.includes(value.model) && !value.customModels.includes(value.model)) value.customModels.push(value.model);
    document.getElementById('gg-project').value = value.project;
    addModels();
    selectSource(SOURCE);
    return true;
}

function installConnectionPersistence() {
    const ctx = context();
    const on = (name, handler) => { if (ctx.eventTypes[name]) ctx.eventSource.on(ctx.eventTypes[name], handler); };
    const profileMarker = profile => profile?.[CONNECTION_META];
    const selectedProfile = () => {
        const manager = context().extensionSettings.connectionManager;
        return manager?.profiles?.find(profile => profile.id === manager.selectedProfile);
    };
    const recordProfile = profile => {
        if (!profile) return;
        if (profile.exclude?.includes('api')) {
            delete profile[CONNECTION_META];
            if (profile.api === SOURCE) delete profile.api;
        } else profile[CONNECTION_META] = isPlatformActive() ? connectionSnapshot() : { source: 'native' };
        normalizeProfile(profile);
        context().saveSettingsDebounced();
    };
    on('CONNECTION_PROFILE_CREATED', recordProfile);
    on('CONNECTION_PROFILE_UPDATED', (_old, profile) => recordProfile(profile));
    on('CONNECTION_PROFILE_LOADED', () => {
        loadingProfile = undefined;
        const profile = selectedProfile();
        if (!restoreConnection(profileMarker(profile))) {
            if (profile?.api) settings().platformActive = false;
            syncSourceUi();
            syncPresetIdentity();
            context().saveSettingsDebounced();
        }
    });
    const beginProfile = event => {
        const manager = context().extensionSettings.connectionManager;
        const id = event.target.id === 'connection_profiles' ? event.target.value : manager?.selectedProfile;
        const profile = manager?.profiles?.find(entry => entry.id === id);
        loadingProfile = profile?.api ? profileMarker(profile) ?? { source: 'native' } : undefined;
    };
    document.getElementById('connection_profiles')?.addEventListener('change', beginProfile, true);
    document.getElementById('reload_connection_profile')?.addEventListener('click', beginProfile, true);
    on('OAI_PRESET_CHANGED_BEFORE', data => {
        applyingPreset = true;
        if (!data.settings.bind_preset_to_connection) return;
        const keepCurrent = settings().platformActive && data.presetName === data.presetNameBefore;
        const saved = loadingProfile ?? data.preset.extensions?.[CONNECTION_META] ?? (keepCurrent ? connectionSnapshot() : undefined);
        settings().platformActive = saved?.source === SOURCE;
        if (!settings().platformActive) return;
        useDirectConnection();
        const value = settings();
        if (validModel(saved.model)) value.model = saved.model;
        value.project = validProject(saved.project) ? saved.project : '';
        if (!MODELS.includes(value.model) && !value.customModels.includes(value.model)) value.customModels.push(value.model);
        addModels();
        Object.assign(data.preset, {
            chat_completion_source: 'vertexai', vertexai_auth_mode: 'express', vertexai_region: 'global',
            vertexai_model: value.model, vertexai_express_project_id: value.project,
            reverse_proxy: '', proxy_password: '',
        });
        data.preset.extensions ??= {};
        data.preset.extensions[CONNECTION_META] = connectionSnapshot();
        document.getElementById('gg-project').value = value.project;
    });
    on('OAI_PRESET_CHANGED_AFTER', () => {
        applyingPreset = false;
        syncSourceUi();
        syncPresetIdentity();
        context().saveSettingsDebounced();
    });
}

function settings() {
    const all = context().extensionSettings;
    all[NAME] ??= {};
    const value = all[NAME];
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
    if (active) useDirectConnection();
    facade.value = active ? SOURCE : original.value;
    document.getElementById('vertexai_form').classList.toggle('gg-platform-active', active);
    document.getElementById('gemini-global').hidden = !active;
    if (active) document.getElementById('gg-key-slot').append(nativeKeyRow);
    else nativeKeyAnchor.after(nativeKeyRow);
    document.getElementById('openai_proxy_preset')?.closest('.inline-drawer')?.classList.toggle('gg-platform-proxy-hidden', active);
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
        addModels();
        useDirectConnection();
        Object.assign(native, {
            vertexai_auth_mode: 'express', vertexai_region: 'global',
            vertexai_express_project_id: value.project, vertexai_model: value.model,
        });
    } else {
        const previous = value.previousVertex;
        const restore = value.platformActive && previous;
        value.platformActive = false;
        if (restore) restoreProxy();
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
    syncPresetIdentity();
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
        if (syncingSource || applyingPreset) return;
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
    el.hidden = !message;
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

async function request(data, signal) {
    // This internal lookup intentionally receives a model-not-found response. Keep
    // it out of chat fetch wrappers that inject tools or interpret 404 as chat failure.
    const response = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const cleanup = () => signal?.removeEventListener('abort', abort);
        xhr.open('POST', '/api/backends/chat-completions/generate');
        for (const [key, value] of Object.entries(context().getRequestHeaders())) xhr.setRequestHeader(key, value);
        xhr.onload = () => { cleanup(); resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.responseText }); };
        xhr.onerror = () => { cleanup(); reject(new Error('無法連線到酒館伺服器。')); };
        xhr.onabort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        xhr.send(JSON.stringify(data));
    });
    const text = response.text;
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

async function ensureProject(forceDiscovery = false) {
    if (projectPromise) return projectPromise;
    const input = document.getElementById('gg-project');
    const manual = input.value.trim();
    if (manual && !validProject(manual)) throw new Error('Project ID 或 Project Number 格式不正確。');
    function apply(project) {
        settings().project = project;
        input.value = project;
        if (settings().platformActive && context().chatCompletionSettings.chat_completion_source === 'vertexai') {
            context().chatCompletionSettings.vertexai_express_project_id = project;
            $('#vertexai_express_project_id').val(project).trigger('input');
        }
        context().saveSettingsDebounced();
        syncPresetIdentity();
        status('');
        return project;
    }
    if (manual && !forceDiscovery) return apply(manual);
    if (!secret_state[SECRET_KEYS.VERTEXAI]) throw new Error('請先輸入 API Key，並按酒館的「連線」儲存。');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    status('正在自動設定專案…');
    projectPromise = (async () => {
        try {
            const project = await discoverProject(controller.signal);
            delete input.dataset.manual;
            status('');
            return apply(project);
        } catch (error) {
            const message = error.name === 'AbortError' ? '專案偵測逾時；請在進階設定填入 Project ID 後重試。' : error.message;
            status(message, 'error');
            throw new Error(message);
        } finally {
            clearTimeout(timeout);
            projectPromise = undefined;
        }
    })();
    return projectPromise;
}

function init() {
    const form = document.getElementById('vertexai_form');
    if (!form || !document.getElementById('vertexai_express_project_id')) {
        toastr.error('Gemini Global 需要支援 Vertex AI Project ID 的酒館版本（1.13.1 以上）。');
        return;
    }
    const existing = document.getElementById('gemini-global');
    if (existing) {
        if (existing.dataset.runtimeVersion !== RUNTIME_VERSION) {
            const message = `Gemini Agent Platform ${RUNTIME_VERSION} 已載入，但另一份舊擴充已先建立介面。請停用重複的 Gemini 擴充，再重新整理。`;
            let warning = document.getElementById('gg-runtime-conflict');
            if (!warning) {
                warning = document.createElement('p');
                warning.id = 'gg-runtime-conflict';
                warning.setAttribute('role', 'alert');
                existing.prepend(warning);
            }
            warning.textContent = message;
            toastr.error(message, 'Gemini Agent Platform');
        }
        return;
    }
    if (CORE_VERSION !== RUNTIME_VERSION) {
        toastr.error('Gemini Agent Platform 的程式與核心檔版本不一致，請更新擴充並重新整理。');
        return;
    }
    const panel = document.createElement('section');
    panel.id = 'gemini-global';
    panel.dataset.runtimeVersion = RUNTIME_VERSION;
    panel.innerHTML = `
        <small class="gg-hint">Google Cloud 直連；不使用酒館反向代理。</small>
        <div class="gg-field">
            <label for="api_key_vertexai">API Key</label>
            <div id="gg-key-slot"></div>
        </div>
        <div class="gg-field">
            <label for="gg-model">模型</label>
            <select id="gg-model" class="text_pole"></select>
        </div>
        <p id="gg-status" role="status" aria-live="polite" hidden></p>
        <details class="gg-advanced">
            <summary>進階設定</summary>
            <small id="gg-runtime-version" class="gg-hint">實際執行版本：${RUNTIME_VERSION}</small>
            <div class="gg-field">
                <label for="gg-project">Project ID / Project Number</label>
                <input id="gg-project" class="text_pole" type="text" autocomplete="off" placeholder="自動偵測；也可手動填入">
                <small class="gg-hint">預設自動設定專案與 global 區域。</small>
            </div>
            <div class="gg-field">
                <label for="gg-custom">自訂模型</label>
                <div class="gg-custom-row">
                    <input id="gg-custom" class="text_pole" placeholder="gemini-…">
                    <button id="gg-add" class="menu_button" type="button">加入</button>
                </div>
            </div>
        </details>`;
    form.prepend(panel);
    const value = settings();
    // Reuse the actual native input and Key Manager so ST owns saving and masking.
    const keyInput = document.getElementById('api_key_vertexai');
    nativeKeyRow = keyInput.parentElement;
    nativeKeyAnchor = document.createComment('Native Vertex AI key position');
    nativeKeyRow.before(nativeKeyAnchor);
    document.getElementById('gg-key-slot').append(nativeKeyRow);
    keyInput.type = 'password';
    keyInput.placeholder = '輸入 API Key；留空使用已儲存的金鑰';
    document.getElementById('gg-project').value = value.project;
    addModels();
    installSourceSelector();
    installProfileCommands();
    installConnectionPersistence();
    document.getElementById('gg-project').addEventListener('input', event => {
        event.target.dataset.manual = 'true';
    });
    document.getElementById('gg-model').addEventListener('change', event => {
        settings().model = event.target.value;
        $('#model_vertexai_select').val(event.target.value).trigger('change');
        syncPresetIdentity();
        context().saveSettingsDebounced();
    });
    $('#model_vertexai_select').on('change.geminiGlobal', event => {
        const model = event.target.value;
        if (settings().platformActive && [...MODELS, ...settings().customModels].includes(model)) {
            settings().model = model;
            document.getElementById('gg-model').value = model;
            syncPresetIdentity();
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
    const active = () => settings().platformActive && context().chatCompletionSettings.chat_completion_source === 'vertexai';
    // Native Connect saves the native input. Once saved, discover the matching project.
    ctx.eventSource.on(ctx.eventTypes.SECRET_WRITTEN, async key => {
        if (key !== SECRET_KEYS.VERTEXAI || !active()) return;
        const manual = document.getElementById('gg-project').dataset.manual;
        try { await ensureProject(!manual); } catch (error) { status(error.message, 'error'); }
    });
    $('#api_button_openai').on('click.geminiGlobal', async event => {
        if (!event.originalEvent || !active() || keyInput.value.trim() || !secret_state[SECRET_KEYS.VERTEXAI]) return;
        try { await ensureProject(); } catch (error) { status(error.message, 'error'); }
    });
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, async data => {
        if (!active() || data.chat_completion_source !== 'vertexai') return;
        // Clear legacy proxy fields even if project lookup fails or the helper
        // produced an empty model. The native status check also needs direct settings.
        useDirectConnection();
        data.reverse_proxy = '';
        data.proxy_password = '';
        try {
            const project = await ensureProject();
            prepareRequest(data, { ...settings(), enabled: true, project });
        } catch (error) {
            status(error.message, 'error');
            throw error;
        }
    });
    syncPresetIdentity();
}

$(init);
