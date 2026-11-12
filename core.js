export const MODELS = Object.freeze(['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash']);

export function validModel(value) {
    return /^gemini-[a-zA-Z0-9._-]+$/.test(value);
}

export function validProject(value) {
    return /^(?:[0-9]{6,}|[a-z][a-z0-9-]{4,61}[a-z0-9])$/.test(value);
}

export function extractProject(value) {
    const match = String(value).match(/projects\/([a-zA-Z0-9-]+)\/locations\//);
    return match && validProject(match[1]) ? match[1] : '';
}

export function safeError(value) {
    return String(value).replace(/AIza[0-9A-Za-z_-]+/g, '[REDACTED]').slice(0, 800);
}

export function prepareRequest(data, { enabled, project, model: selectedModel, customModels = [] }) {
    if (!enabled || data.chat_completion_source !== 'vertexai') return false;
    // Direct routing belongs to the selected source, regardless of model lookup.
    data.reverse_proxy = '';
    data.proxy_password = '';
    const requested = typeof data.model === 'string' ? data.model.trim() : '';
    data.model = requested || selectedModel;
    if (!validModel(data.model)) throw new Error('請在 Gemini Agent Platform 選擇有效的 Gemini 模型。');
    data.vertexai_auth_mode = 'express';
    data.vertexai_region = 'global';
    if (!validProject(project)) throw new Error('請先在 Gemini Global 面板設定或自動偵測 Project ID。');
    data.vertexai_express_project_id = project;
    if (![...MODELS, ...customModels].includes(data.model)) return true;
    // New Gemini models use server defaults for sampling. Do not forward old presets.
    for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'seed']) {
        delete data[key];
    }
    // Older ST builds may map "minimal" to an unsupported thinking level for 3.8.
    if (data.reasoning_effort === 'min') data.reasoning_effort = 'low';
    return true;
}

export function testRequest(model, project = '') {
    return {
        chat_completion_source: 'vertexai',
        vertexai_auth_mode: 'express',
        vertexai_express_project_id: project,
        vertexai_region: 'global',
        reverse_proxy: '',
        proxy_password: '',
        model,
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        max_tokens: 512,
        stream: false,
        use_sysprompt: true,
        reasoning_effort: 'low',
        include_reasoning: false,
    };
}
