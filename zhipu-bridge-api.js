// ============================================================
// zhipu-bridge-api.js —— 本地图像分析桥接服务 v2.0.0
//
// 端口 8765，暴露：
//   GET /health                    健康检查（MCP 自动拉起用）
//   GET /analyze?path=...&...      分析图片，返回统一 JSON + 停/续控制
//
// 主要能力：
//   - 视觉模型统一调用（vision-client.js，可换提供商、多模型回退）
//   - 模型自动判断 next_action(continue/stop)，流程由调用方(Claude)执行
//   - 图片 MD5 去重缓存 / 按用户限流 / JSONL 用量日志
//   - ?task=error|ui|ocr|general 提示词模板，?lang=zh|en 输出语言
//   - ?force_action=continue|stop 确定性测试钩子；?raw=1 原始透传
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { analyzeImage, loadConfig } = require('./vision-client');

// ========== 配置区（全部可用环境变量覆盖） ==========
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8765);
const MAX_LONG_SIDE = Number(process.env.MAX_LONG_SIDE || 1920);   // 图片压缩长边上限
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 3600 * 1000); // 去重缓存 TTL，默认 1h
const CACHE_MAX = Number(process.env.CACHE_MAX || 500);              // 缓存条数上限
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 0); // 0=不限
const RATE_LIMIT_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 0); // 0=不限
const USAGE_LOG = process.env.USAGE_LOG !== '0';
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const VERSION = '2.0.0';
const [PRIMARY_CFG] = loadConfig(); // 仅用于 /health 展示
// ============================================================

// ---------- 提示词模板（扩展点 G：任务类型 + 语言） ----------
const PROMPT_TAIL = `
根据分析结果，自主决定本次分析流程是否应该结束：
- 若截图明确显示任务成功、流程已完成、内容已分析完毕、或用户明确表示结束 → next_action 输出 "stop"。
- 否则 → next_action 输出 "continue"，表示可继续等待下一张截图。

请严格只输出一个 JSON 对象，不要输出任何多余文字、解释、Markdown 代码块标记。格式：
{
  "analysis": "完整详细的截图内容分析（全部文字、报错、界面）",
  "next_action": "continue 或 stop",
  "reason": "一句话说明继续或停止的原因"
}`;

const PROMPT_TEMPLATES = {
    general: (lang) => `你是一个专业的截图分析助手。请仔细分析用户提供的截图，提取全部文字、报错信息、按钮与界面元素、操作状态等，力求完整准确。${langPrompt(lang)}`,
    error: (lang) => `你是一个专业的报错定位助手。请仔细分析用户提供的截图，重点提取：错误类型、报错文字/堆栈、错误码、错误触发条件、涉及的文件或接口、以及修复思路。${langPrompt(lang)}`,
    ui: (lang) => `你是一个专业的界面走查助手。请仔细分析用户提供的截图，提取：界面元素、布局结构、文案内容、操作状态（加载/成功/失败/禁用）、可点击区域与交互提示。${langPrompt(lang)}`,
    ocr: (lang) => `你是一个专业的 OCR 助手。请完整提取截图中的所有文字内容，按视觉顺序排列，尽量保留原始排版。${langPrompt(lang)}`
};

function langPrompt(lang) {
    return lang === 'en' ? '\n请使用 English 输出 analysis。' : '\n请使用中文输出 analysis。';
}

function buildPrompt(task, lang, desc) {
    const tpl = PROMPT_TEMPLATES[task] || PROMPT_TEMPLATES.general;
    let p = tpl(lang) + PROMPT_TAIL;
    if (desc) p += `\n用户附加说明：${desc}`;
    return p;
}

// ---------- 健壮 JSON 解析（导出便于单测） ----------
function extractAnalysis(content) {
    let raw = Array.isArray(content)
        ? content.filter(c => c && c.type === 'text').map(c => c.text).join('\n')
        : String(content ?? '');

    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

    let parsed = tryParse(raw);
    let status = 'ok';

    // 1. 去掉 ```json 围栏
    if (!parsed) {
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) parsed = tryParse(fenced[1].trim());
    }
    // 2. 截取首个 { 到末个 }
    if (!parsed) {
        const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
        if (i >= 0 && j > i) parsed = tryParse(raw.slice(i, j + 1));
    }
    // 3. 二次编码：JSON.parse 出来是字符串，再 parse 一次
    if (parsed && typeof parsed === 'string') {
        const inner = tryParse(parsed);
        if (inner) parsed = inner;
    }
    // 4. 单键包裹：{"result":"{...}"} 之类
    if (parsed && typeof parsed === 'object' && parsed !== null
        && typeof parsed.analysis !== 'string' && typeof parsed.next_action !== 'string') {
        const inner = parsed.result || parsed.output || parsed.data || parsed.content;
        if (typeof inner === 'string') {
            const innerParsed = tryParse(inner);
            if (innerParsed) parsed = innerParsed;
        }
    }

    if (parsed && typeof parsed === 'object' && parsed !== null) {
        const action = String(parsed.next_action ?? '').trim().toLowerCase() === 'stop' ? 'stop' : 'continue';
        const reason = String(parsed.reason ?? '').trim();
        return { raw, analysis: String(parsed.analysis ?? '').trim(), action, reason, status };
    }

    // 5. 正则回退：从散文里抠 next_action
    const m = raw.match(/["']?next_action["']?\s*[:：]\s*["']?(continue|stop)["']?/i);
    if (m) {
        return { raw, analysis: raw.trim(), action: m[1].toLowerCase(), reason: '（通过正则回退提取）', status: 'fallback' };
    }

    // 6. 兜底：默认 continue（误判 stop 会错误终止流程，更糟）
    return { raw, analysis: raw.trim(), action: 'continue', reason: '模型输出无法解析，默认继续', status: 'failed' };
}

// ---------- 去重缓存（扩展点 E） ----------
const cache = new Map();
function cacheGet(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.exp) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, item); // 刷新 LRU
    return item.val;
}
function cacheSet(key, val) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { val, exp: Date.now() + CACHE_TTL_MS });
    while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

// ---------- 限流（扩展点 E，按 user 隔离） ----------
const minuteWindows = new Map();
const dayWindows = new Map();
function rateLimit(user) {
    const now = Date.now();
    if (RATE_LIMIT_PER_MIN > 0) {
        const w = Math.floor(now / 60000);
        const rec = minuteWindows.get(user);
        const count = (rec && rec.w === w) ? rec.c : 0;
        if (count >= RATE_LIMIT_PER_MIN) {
            return { limited: true, retryAfter: 60 - Math.floor((now % 60000) / 1000) };
        }
        minuteWindows.set(user, { w, c: count + 1 });
    }
    if (RATE_LIMIT_PER_DAY > 0) {
        const w = Math.floor(now / 86400000);
        const rec = dayWindows.get(user);
        const count = (rec && rec.w === w) ? rec.c : 0;
        if (count >= RATE_LIMIT_PER_DAY) {
            return { limited: true, retryAfter: 86400 - Math.floor((now % 86400000) / 1000) };
        }
        dayWindows.set(user, { w, c: count + 1 });
    }
    return { limited: false };
}

// ---------- 用量日志（扩展点 E，JSONL 按天轮转） ----------
function usageLog(entry) {
    if (!USAGE_LOG) return;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const d = new Date();
        const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
        fs.appendFileSync(path.join(LOG_DIR, `usage-${dateStr}.jsonl`), line + '\n');
    } catch { /* 日志失败不影响主流程 */ }
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
    const start = Date.now();
    res.setHeader('Content-Type', 'application/json');
    try {
        const urlObj = new URL(req.url, `http://127.0.0.1:${LISTEN_PORT}`);
        const route = urlObj.pathname;

        if (route === '/health') {
            res.writeHead(200);
            res.end(JSON.stringify({
                ok: true, status: 'up',
                model: PRIMARY_CFG.model,
                uptime_ms: Math.floor(process.uptime() * 1000),
                cache: { size: cache.size, ttl_ms: CACHE_TTL_MS },
                version: VERSION
            }));
            return;
        }
        if (route !== '/analyze') {
            res.writeHead(404);
            res.end(JSON.stringify({ ok: false, error: '未知端点' }));
            return;
        }

        const imgPath = urlObj.searchParams.get('path');
        const task = urlObj.searchParams.get('task') || 'general';
        const lang = urlObj.searchParams.get('lang') || 'zh';
        const desc = urlObj.searchParams.get('desc') || '';
        const user = urlObj.searchParams.get('user') || 'local';
        const forceAction = urlObj.searchParams.get('force_action');
        const raw = urlObj.searchParams.get('raw') === '1';

        if (!imgPath) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: '缺少path参数，示例：/analyze?path=E:\\temp\\test.png' }));
            return;
        }
        if (!fs.existsSync(imgPath)) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: `文件不存在: ${imgPath}` }));
            return;
        }

        // 限流
        const rl = rateLimit(user);
        if (rl.limited) {
            res.writeHead(429, { 'Retry-After': String(rl.retryAfter) });
            res.end(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后重试', retry_after: rl.retryAfter }));
            return;
        }

        const rawBuf = fs.readFileSync(imgPath);
        const md5 = crypto.createHash('md5').update(rawBuf).digest('hex');

        let analysisRes, provider = null, modelUsed = null, usage = null, cacheHit = 'miss', upstreamRaw = null;
        const cacheKey = `${md5}|${task}|${lang}|${PRIMARY_CFG.model}`;

        const cached = !forceAction && !raw ? cacheGet(cacheKey) : null;
        if (cached) {
            cacheHit = 'hit';
            analysisRes = cached;
        } else if (forceAction === 'continue' || forceAction === 'stop') {
            analysisRes = {
                raw: '',
                analysis: `（测试钩子 force_action=${forceAction}）`,
                action: forceAction,
                reason: 'force_action 测试钩子',
                status: 'ok'
            };
        } else {
            const compressedBuf = await sharp(rawBuf)
                .resize({ width: MAX_LONG_SIDE, height: MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true })
                .toFormat('png')
                .toBuffer();
            const base64 = compressedBuf.toString('base64');
            const prompt = buildPrompt(task, lang, desc);
            const up = await analyzeImage({ base64Png: base64, prompt });
            provider = up.provider; modelUsed = up.model; usage = up.usage;
            upstreamRaw = up.content;
            analysisRes = extractAnalysis(up.content);
            cacheSet(cacheKey, analysisRes);
        }

        if (raw) {
            res.writeHead(200);
            res.end(JSON.stringify(upstreamRaw
                ? { content: upstreamRaw, usage, provider, model: modelUsed }
                : { note: 'raw 仅在真实模型调用时返回原始内容', forced: !!forceAction }));
            return;
        }

        const body = {
            ok: true,
            image: { path: imgPath, md5, bytes: rawBuf.length, compressed_bytes: null },
            analysis: { text: analysisRes.analysis, raw: analysisRes.raw },
            control: {
                action: analysisRes.action,
                reason: analysisRes.reason,
                decided_by: 'model',
                flow_state: analysisRes.action === 'stop' ? 'ended' : 'active'
            },
            meta: {
                model: modelUsed || PRIMARY_CFG.model,
                provider: provider || (forceAction ? 'forced' : cacheHit === 'hit' ? 'cache' : 'unknown'),
                task, lang,
                parse: analysisRes.status,
                cache: cacheHit,
                latency_ms: Date.now() - start,
                forced: !!forceAction,
                bridge_version: VERSION
            }
        };

        usageLog({
            user, md5, task, lang,
            provider: provider || null, model: modelUsed || PRIMARY_CFG.model,
            usage, action: analysisRes.action, cache: cacheHit,
            latency_ms: body.meta.latency_ms, status: 200
        });

        res.writeHead(200);
        res.end(JSON.stringify(body, null, 2));
    } catch (err) {
        usageLog({ user: 'unknown', error: err.message, status: err.providerErrors ? 502 : 500 });
        const status = err.providerErrors ? 502 : 500;
        res.writeHead(status);
        res.end(JSON.stringify({ ok: false, error: err.message, stack: process.env.DEBUG ? err.stack : undefined }));
    }
});

if (require.main === module) {
    server.listen(LISTEN_PORT, '127.0.0.1', () => {
        console.log(`✅图像分析桥接服务 v${VERSION} 已启动，端口 ${LISTEN_PORT}，模型 ${PRIMARY_CFG.model}`);
        console.log(`👉调用示例：http://127.0.0.1:${LISTEN_PORT}/analyze?path=E:\\temp\\screenshot.png`);
    });
}

module.exports = { extractAnalysis, buildPrompt, rateLimit, cacheGet, cacheSet };
