// ============================================================
// vision-client.js —— 视觉 LLM 提供商抽象层（OpenAI 兼容接口）
//
// 只依赖 "OpenAI 兼容的 chat/completions + vision(image_url base64)"
// 这一个接口形状，主流视觉模型（智谱/OpenAI/通义千问-VL/DeepSeek-VL/
// Moonshot/Ollama/vLLM）都支持。换提供商 = 改配置，零代码。
//
// 配置优先级：环境变量 > vision-config.json > 内置默认值
//   主提供商: VISION_API_KEY / VISION_BASE_URL / VISION_MODEL / VISION_CHAT_PATH
//   备选提供商(回退链): VISION_API_KEY_2 / VISION_BASE_URL_2 / VISION_MODEL_2
//   或 vision-config.json 里的 providers 数组（从第 2 项起为备选）
// ============================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, 'vision-config.json');

const DEFAULT_CHAT_PATH = '/chat/completions';

/** 加载提供商列表：env 覆盖主提供商；返回 [{base_url,api_key,model,chat_path,name}] */
function loadConfig() {
    let fileCfg = {};
    try {
        fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch { /* 无配置文件则全部走 env */ }

    const fileProviders = Array.isArray(fileCfg.providers) && fileCfg.providers.length
        ? fileCfg.providers
        : [];

    const providers = [];

    // 主提供商
    const main = fileProviders[0] || {};
    providers.push({
        base_url: process.env.VISION_BASE_URL || main.base_url || fileCfg.base_url || 'https://open.bigmodel.cn/api/paas/v4',
        api_key: process.env.VISION_API_KEY || main.api_key || fileCfg.api_key || '',
        model: process.env.VISION_MODEL || main.model || fileCfg.model || 'glm-4.6v',
        chat_path: process.env.VISION_CHAT_PATH || main.chat_path || fileCfg.chat_path || DEFAULT_CHAT_PATH,
        name: main.name || 'primary'
    });

    // 备选：env 备选
    if (process.env.VISION_API_KEY_2) {
        providers.push({
            base_url: process.env.VISION_BASE_URL_2 || 'https://api.openai.com/v1',
            api_key: process.env.VISION_API_KEY_2,
            model: process.env.VISION_MODEL_2 || 'gpt-4o',
            chat_path: DEFAULT_CHAT_PATH,
            name: 'backup-env'
        });
    }
    // 备选：配置文件里第 2 项起
    for (let i = 1; i < fileProviders.length; i++) {
        const p = fileProviders[i];
        providers.push({
            base_url: p.base_url,
            api_key: p.api_key || '',
            model: p.model,
            chat_path: p.chat_path || DEFAULT_CHAT_PATH,
            name: p.name || `backup-${i}`
        });
    }
    return providers;
}

/** 是否属于"瞬时/可重试"错误（决定要不要切备选提供商） */
function isTransientError(err, status) {
    if (!err) return false;
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'].includes(err.code);
}

/**
 * 调用视觉模型，按序尝试主→备选提供商，瞬时错误自动切下一个。
 * @param {object} opts
 * @param {string[]} [opts.base64Images]  多张压缩后的 PNG base64（推荐）
 * @param {string}   [opts.base64Png]     单张（兼容；内部并入 base64Images）
 * @param {string} opts.prompt      提示词（含任务模板与 JSON 输出要求）
 * @returns {Promise<{content:string, provider:string, model:string, usage:object|null}>}
 */
async function analyzeImage({ base64Images = [], base64Png, prompt, maxTokens = 2000, temperature = 0.2 }) {
    const images = (Array.isArray(base64Images) && base64Images.length)
        ? base64Images
        : (base64Png ? [base64Png] : []);
    if (!images.length) {
        const e = new Error('没有可分析的图片');
        throw e;
    }

    const providers = loadConfig();
    const errors = [];

    for (const prov of providers) {
        if (!prov.api_key) {
            errors.push(`${prov.name}: 缺少 api_key（请配置 VISION_API_KEY 或 vision-config.json）`);
            continue;
        }
        try {
            const payload = {
                model: prov.model,
                max_tokens: maxTokens,
                temperature: temperature,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            ...images.map((b64) => ({
                                type: 'image_url',
                                image_url: { url: `data:image/png;base64,${b64}` }
                            }))
                        ]
                    }
                ]
            };
            const resp = await axios.post(`${prov.base_url}${prov.chat_path}`, payload, {
                headers: { Authorization: `Bearer ${prov.api_key}`, 'Content-Type': 'application/json' },
                timeout: 60000
            });
            const data = resp.data;
            const content = data?.choices?.[0]?.message?.content ?? '';
            return {
                content,
                provider: prov.name,
                model: prov.model,
                usage: data?.usage || null
            };
        } catch (err) {
            const status = err.response?.status;
            errors.push(`${prov.name}: ${status ? `HTTP ${status} ${err.response?.data?.error?.message ?? ''}` : (err.code || err.message)}`);
            // 非瞬时错误（如 400 格式问题）也会切下一个提供商试一次；
            // 全部失败统一在下方抛出。
        }
    }

    const e = new Error(`所有视觉提供商均调用失败: ${errors.join(' | ')}`);
    e.providerErrors = errors;
    throw e;
}

module.exports = { analyzeImage, loadConfig, isTransientError };
