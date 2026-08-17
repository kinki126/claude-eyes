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
const VERSION = '1.4.0';
const [PRIMARY_CFG] = loadConfig(); // 仅用于 /health 展示
// ============================================================

// ---------- 提示词模板（扩展点 G：任务类型 + 语言） ----------
const PROMPT_TAIL = `
附加标注（最高优先级）：识别并分析截图里所有【不属于原图】的用户附加内容——例如框选、高亮、圆圈、箭头、下划线、手写/涂鸦笔迹、批注文字、贴纸、马赛克等，任何在原图上叠加的标注、符号或文字。请：
- 把这些附加内容视为用户最想让你关注的重点，优先仔细分析。
- 把标注区域内的文字（含用户手写或批注的文字、被框住的原图文字）一字不差地完整转录到 "annotated_text" 字段。
- 用一句话在 analysis 里说明标注所在的大致位置。
- 分析标注指向的是什么错误/状态/问题。
- 把截图里的报错堆栈、报错消息、错误码、关键日志等【原文】一字不差、完整转录到 "verbatim" 字段——不要概括、不要省略、不要改写（analysis 可以概括，verbatim 必须是原文）。
- 为每个用户附加标注区域、以及每个关键报错/关键界面元素，输出其在截图中的归一化位置到 "regions" 字段。

根据分析结果，自主决定本次分析流程是否应该结束：
- 若截图明确显示任务成功、流程已完成、内容已分析完毕、或用户明确表示结束 → next_action 输出 "stop"。
- 否则 → next_action 输出 "continue"，表示可继续等待下一张截图。

请严格只输出一个 JSON 对象，不要输出任何多余文字、解释、Markdown 代码块标记。格式：
{
  "analysis": "完整详细的截图内容分析（全部文字、报错、界面）",
  "verbatim": "截图里关键原文的完整逐字转录（报错堆栈/报错消息/错误码/日志等，一字不差、不概括；无则空字符串）",
  "annotated_text": "用户附加标注区域内文字的逐字转录（截图无任何用户标注则为空字符串）",
  "keywords": ["从截图提取的、可用于代码检索的关键词，如报错函数名/错误码/文件名/接口路径等，最多 10 个"],
  "regions": [{"label":"框选|高亮|箭头|报错|按钮|文本|其他","bbox":{"x":0.1,"y":0.2,"w":0.3,"h":0.1},"text":"该区域内文字","note":"一句话说明"}],
  "next_action": "continue 或 stop",
  "reason": "一句话说明继续或停止的原因"
}

regions 说明：bbox 使用归一化坐标——x/y 为区域左上角、w/h 为宽高，范围均为 0.0~1.0（相对整张图，与图片实际像素尺寸无关）。每个标注区域和每个关键界面元素各一条；没有明确区域时 "regions" 输出空数组 []。`;

const PROMPT_TEMPLATES = {
    general: (lang) => `你是一个专业的截图分析助手。请仔细分析用户提供的截图，提取全部文字、报错信息、按钮与界面元素、操作状态等，力求完整准确。${langPrompt(lang)}`,
    error: (lang) => `你是一个专业的报错定位助手。请仔细分析用户提供的截图，重点提取：错误类型、报错文字/堆栈、错误码、错误触发条件、涉及的文件或接口、以及修复思路。${langPrompt(lang)}`,
    ui: (lang) => `你是一个专业的界面走查助手。请仔细分析用户提供的截图，提取：界面元素、布局结构、文案内容、操作状态（加载/成功/失败/禁用）、可点击区域与交互提示。${langPrompt(lang)}`,
    ocr: (lang) => `你是一个专业的 OCR 助手。请完整提取截图中的所有文字内容，按视觉顺序排列，尽量保留原始排版。${langPrompt(lang)}`,
    diff: (lang) => `你是一个专业的界面/截图对比助手。请先分别描述用户提供的每一张截图的内容，再重点对比各截图之间的差异（新增、删除、变化的部分），从界面元素、文案、状态等角度列出。${langPrompt(lang)}`,
    verify: (lang) => `你是一个截图内容真伪核验助手。用户会给出一个关于截图的断言（claim），请仔细核对截图，判断该断言是否成立，并给出图中证据。${langPrompt(lang)}`
};

function langPrompt(lang) {
    return lang === 'en' ? '\n请使用 English 输出 analysis。' : '\n请使用中文输出 analysis。';
}

function buildPrompt(task, lang, desc, focus) {
    const tpl = PROMPT_TEMPLATES[task] || PROMPT_TEMPLATES.general;
    let p = tpl(lang);
    if (task === 'verify') {
        p += `\n待核验的断言：${desc || '（未提供断言）'}`;
        p += `\n\n请严格只输出一个 JSON 对象，不要输出任何多余文字、解释、Markdown 代码块标记。格式：
{
  "verdict": "true 或 false 或 uncertain",
  "evidence": "图中支持或反驳该断言的具体证据（引用原文 / 描述位置）",
  "analysis": "一句话总结核验结论"
}

verdict 判定规则：true = 截图内容支持该断言成立；false = 截图内容明确反驳该断言；uncertain = 无法从截图确定（信息不足或图中没有相关内容）。`;
        return p;
    }
    p += PROMPT_TAIL;
    if (desc) p += `\n用户附加说明：${desc}`;
    if (focus) p += `\n${focusPrompt(focus)}`;
    return p;
}

function focusPrompt(focus) {
    return `重点关注区域/问题（最高优先级，覆盖默认全面分析）：${focus}。请：
- 把该区域/问题作为本次分析的核心，优先、仔细分析，analysis 围绕它展开。
- annotated_text 优先转录该区域内的文字。
- keywords 优先提取与该区域相关的可检索关键词。
- regions 优先输出该区域的归一化 bbox 定位。`;
}

// ---------- 健壮 JSON 解析（导出便于单测） ----------
/** 解析 regions：bbox 归一化到 [0,1]，尺度自适应（[0,1] / 0~100 / 0~1000），坏值过滤 */
function parseRegions(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 20).map((r) => {
        if (typeof r !== 'object' || r === null) return null;
        const b = r.bbox && typeof r.bbox === 'object' ? r.bbox : null;
        const vals = b ? [b.x, b.y, b.w, b.h].map(Number) : [];
        const valid = vals.length === 4 && vals.every((v) => Number.isFinite(v));
        if (!valid) {
            return { label: String(r.label ?? '').trim(), bbox: null, text: String(r.text ?? '').trim(), note: String(r.note ?? '').trim() };
        }
        // 尺度判断（整体一致）：任一值 >100 → 0~1000；否则任一值 >1 → 0~100；否则 [0,1]
        let scale = 1;
        if (vals.some((v) => v > 100)) scale = 1000;
        else if (vals.some((v) => v > 1)) scale = 100;
        const [x, y, w, h] = vals.map((v) => Math.max(0, Math.min(1, v / scale)));
        return { label: String(r.label ?? '').trim(), bbox: { x, y, w, h }, text: String(r.text ?? '').trim(), note: String(r.note ?? '').trim() };
    }).filter((r) => r && (r.label || r.text || r.bbox));
}

/** 解析 crop_bbox：归一化 {x,y,w,h}，尺度自适应（同 parseRegions），非法返回 null */
function parseCropBbox(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const vals = [raw.x, raw.y, raw.w, raw.h].map(Number);
    if (vals.length !== 4 || vals.some(v => !Number.isFinite(v))) return null;
    let scale = 1;
    if (vals.some(v => v > 100)) scale = 1000;
    else if (vals.some(v => v > 1)) scale = 100;
    let [x, y, w, h] = vals.map(v => Math.max(0, Math.min(1, v / scale)));
    // 防越界：x+w / y+h 不超过 1
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
}

/** 按 cropBbox 裁剪 rawBuf 并放大到最小边 MIN_EDGE，返回 Buffer；不支持的格式返回 null */
async function cropAndEnlarge(rawBuf, bbox, minEdge = 800) {
    try {
        const meta = await sharp(rawBuf).metadata();
        if (!meta.width || !meta.height) return null;
        const pxW = Math.max(1, Math.round(bbox.w * meta.width));
        const pxH = Math.max(1, Math.round(bbox.h * meta.height));
        const left = Math.round(bbox.x * meta.width);
        const top = Math.round(bbox.y * meta.height);
        let extractLeft = Math.max(0, left);
        let extractTop = Math.max(0, top);
        let extractW = pxW;
        let extractH = pxH;
        if (extractLeft + extractW > meta.width) extractW = meta.width - extractLeft;
        if (extractTop + extractH > meta.height) extractH = meta.height - extractTop;
        if (extractW <= 0 || extractH <= 0) return null;
        return await sharp(rawBuf)
            .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
            .resize({ width: minEdge, height: minEdge, fit: 'inside', withoutEnlargement: false })
            .toFormat('png')
            .toBuffer();
    } catch {
        return null;
    }
}

/**
 * 按图本身的特征选输出格式：照片类（无 alpha + 来自 jpeg/webp）→ WebP q=80；UI/文字 → PNG（无损）
 * 启发式：仅 jpeg/webp 来源且无 alpha 通道 → 视为照片
 */
async function chooseFormat(rawBuf) {
    try {
        const meta = await sharp(rawBuf).metadata();
        const isPhotoSource = ['jpeg', 'webp', 'jpg'].includes(meta.format || '');
        const hasAlpha = Boolean(meta.hasAlpha);
        if (isPhotoSource && !hasAlpha) {
            return { format: 'webp', quality: 80 };
        }
        return { format: 'png', quality: null };
    } catch {
        return { format: 'png', quality: null };
    }
}

/**
 * 超长图切片：长宽比 > 3 的图按高度切成 N 段（最多 5 段，每段间重叠 10%）
 * 返回 Buffer[]（已切好的段）；不超长则返回 [rawBuf] 单元素
 */
async function sliceLongImage(rawBuf, maxRatio = 3, maxSlices = 5) {
    try {
        const meta = await sharp(rawBuf).metadata();
        if (!meta.width || !meta.height) return [rawBuf];
        const longSide = Math.max(meta.width, meta.height);
        const shortSide = Math.min(meta.width, meta.height);
        const ratio = longSide / shortSide;
        if (ratio <= maxRatio) return [rawBuf];

        // 横长 vs 竖长
        const isVertical = meta.height > meta.width;
        const sliceCount = Math.min(maxSlices, Math.ceil(ratio / maxRatio));
        const overlap = 0.1; // 10% 重叠避免关键信息被切到中间
        const totalLen = isVertical ? meta.height : meta.width;
        const sliceLen = Math.ceil(totalLen / (sliceCount - (sliceCount - 1) * overlap));
        const step = Math.floor(sliceLen * (1 - overlap));

        const slices = [];
        for (let i = 0; i < sliceCount; i++) {
            const start = i * step;
            let end = start + sliceLen;
            if (end > totalLen) end = totalLen;
            const len = end - start;
            if (len <= 0) break;
            let s;
            if (isVertical) {
                s = await sharp(rawBuf).extract({ left: 0, top: start, width: meta.width, height: len }).toBuffer();
            } else {
                s = await sharp(rawBuf).extract({ left: start, top: 0, width: len, height: meta.height }).toBuffer();
            }
            slices.push(s);
            if (end >= totalLen) break;
        }
        return slices.length ? slices : [rawBuf];
    } catch {
        return [rawBuf];
    }
}

/**
 * OCR 二值化预处理：转灰度 + 直方图均衡 + 阈值二值化，输出 PNG
 * 仅 task=ocr 时启用；其他 task 保留原色（UI 需要看颜色）
 */
async function ocrPreprocess(rawBuf) {
    try {
        return await sharp(rawBuf)
            .greyscale()
            .normalise()
            .threshold(128)
            .toFormat('png')
            .toBuffer();
    } catch {
        return rawBuf;
    }
}

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
        const keywords = Array.isArray(parsed.keywords)
            ? parsed.keywords.map(String).slice(0, 10)
            : [];
        const annotatedText = String(parsed.annotated_text ?? '').trim();
        const verbatim = String(parsed.verbatim ?? '').trim();
        const regions = parseRegions(parsed.regions);
        const verdictRaw = String(parsed.verdict ?? '').trim().toLowerCase();
        const verdict = ['true', 'false', 'uncertain'].includes(verdictRaw) ? verdictRaw : null;
        const evidence = String(parsed.evidence ?? '').trim();
        return { raw, analysis: String(parsed.analysis ?? '').trim(), action, reason, keywords, annotatedText, verbatim, regions, verdict, evidence, status };
    }

    // 5. 正则回退：从散文里抠 next_action
    const m = raw.match(/["']?next_action["']?\s*[:：]\s*["']?(continue|stop)["']?/i);
    if (m) {
        return { raw, analysis: raw.trim(), action: m[1].toLowerCase(), reason: '（通过正则回退提取）', keywords: [], annotatedText: '', verbatim: '', regions: [], verdict: null, evidence: '', status: 'fallback' };
    }

    // 6. 兜底：默认 continue（误判 stop 会错误终止流程，更糟）
    return { raw, analysis: raw.trim(), action: 'continue', reason: '模型输出无法解析，默认继续', keywords: [], annotatedText: '', verbatim: '', regions: [], verdict: null, evidence: '', status: 'failed' };
}

// ---------- 分析结果去重缓存（扩展点 E） ----------
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

// ---------- 图片压缩字节缓存（同一张图换 desc/focus 无需重压缩） ----------
// 容量与 TTL 与分析缓存共用配置；TTL 走更长一点（× 2），因为压缩结果对 prompt 无依赖
const IMG_CACHE_TTL_MS = CACHE_TTL_MS * 2;
const imgCache = new Map();
function imgCacheGet(md5) {
    const item = imgCache.get(md5);
    if (!item) return null;
    if (Date.now() > item.exp) { imgCache.delete(md5); return null; }
    imgCache.delete(md5); imgCache.set(md5, item);
    return { base64: item.base64, compressedBytes: item.compressedBytes };
}
function imgCacheSet(md5, base64, compressedBytes) {
    if (imgCache.has(md5)) imgCache.delete(md5);
    imgCache.set(md5, { base64, compressedBytes, exp: Date.now() + IMG_CACHE_TTL_MS });
    while (imgCache.size > CACHE_MAX) {
        const oldest = imgCache.keys().next().value;
        if (oldest === undefined) break;
        imgCache.delete(oldest);
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

// ---------- 分析历史持久化（扩展点，落盘 JSONL） ----------
const HISTORY_DIR = path.join(__dirname, '.claude-eyes');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.jsonl');
function historyLog(entry) {
    try {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
        fs.appendFileSync(HISTORY_FILE, line + '\n');
    } catch { /* 失败不影响主流程 */ }
}

// ---------- task 自动路由：用户描述/聚焦关键词 → task ----------
const TASK_ROUTING_RULES = [
    { task: 'error', keywords: ['报错', '错误', 'exception', 'stack trace', '崩溃', 'traceback', '错误码', 'error code', 'panic', 'fatal'] },
    { task: 'diff',  keywords: ['对比', 'diff', '之前', '之后', '差异', '比较', 'before', 'after', '变化'] },
    { task: 'ocr',   keywords: ['文字', '提取文字', 'ocr', '转录', '识别文字', '识别出文字', '内容是什么'] },
    { task: 'ui',    keywords: ['界面', '布局', '按钮', '走查', 'ui review', '元素', '组件', '样式'] }
];
function routeTaskByContext(currentTask, desc, focus) {
    if (currentTask && currentTask !== 'general') return currentTask; // 显式指定优先
    const text = `${desc || ''} ${focus || ''}`.toLowerCase();
    if (!text.trim()) return currentTask;
    for (const rule of TASK_ROUTING_RULES) {
        for (const kw of rule.keywords) {
            if (text.includes(kw.toLowerCase())) return rule.task;
        }
    }
    return currentTask;
}

// ---------- Metrics：内存内滚动统计，供 /metrics 端点导出 ----------
const METRICS_WINDOW_MS = 10 * 60 * 1000; // 滚动窗口 10 分钟
const metrics = {
    requests: 0,                    // 总请求数
    errors: 0,                       // 错误请求数
    cacheHits: 0,                    // 缓存命中数
    cacheMisses: 0,                  // 缓存未命中数
    latencies: [],                   // 最近 latency 样本（毫秒，截断窗口内）
    byTask: new Map(),               // task → count
    byProvider: new Map(),           // provider → count
    byUser: new Map(),               // user → count
    errorTypes: new Map(),           // 错误类型 → count
    startedAt: Date.now(),
    /** 推入 latency 样本，自动截断 10 分钟外 */
    pushLatency(ms) {
        const now = Date.now();
        this.latencies.push({ ts: now, ms });
        const cutoff = now - METRICS_WINDOW_MS;
        while (this.latencies.length && this.latencies[0].ts < cutoff) this.latencies.shift();
    },
    /** 计算百分位（p50/p95/p99） */
    percentile(p) {
        if (!this.latencies.length) return 0;
        const sorted = this.latencies.map((x) => x.ms).sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx];
    }
};

function metricsObserve({ user, task, provider, latencyMs, cache, ok, errorType }) {
    metrics.requests++;
    if (ok === false) metrics.errors++;
    if (cache === 'hit') metrics.cacheHits++;
    else if (cache === 'miss') metrics.cacheMisses++;
    if (latencyMs != null) metrics.pushLatency(latencyMs);
    if (user) metrics.byUser.set(user, (metrics.byUser.get(user) || 0) + 1);
    if (task) metrics.byTask.set(task, (metrics.byTask.get(task) || 0) + 1);
    if (provider) metrics.byProvider.set(provider, (metrics.byProvider.get(provider) || 0) + 1);
    if (errorType) metrics.errorTypes.set(errorType, (metrics.errorTypes.get(errorType) || 0) + 1);
}

/** 生成 /metrics 端点的 JSON 报告 */
function metricsReport() {
    return {
        uptime_ms: Date.now() - metrics.startedAt,
        total_requests: metrics.requests,
        total_errors: metrics.errors,
        error_rate: metrics.requests ? (metrics.errors / metrics.requests).toFixed(4) : '0',
        cache_hits: metrics.cacheHits,
        cache_misses: metrics.cacheMisses,
        cache_hit_rate: (metrics.cacheHits + metrics.cacheMisses) ? (metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)).toFixed(4) : '0',
        latency_p50_ms: metrics.percentile(0.5),
        latency_p95_ms: metrics.percentile(0.95),
        latency_p99_ms: metrics.percentile(0.99),
        by_task: Object.fromEntries(metrics.byTask),
        by_provider: Object.fromEntries(metrics.byProvider),
        by_user: Object.fromEntries(metrics.byUser),
        error_types: Object.fromEntries(metrics.errorTypes),
        window_ms: METRICS_WINDOW_MS
    };
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
    const start = Date.now();
    res.setHeader('Content-Type', 'application/json');
    // x-request-id 贯穿：优先复用客户端传入，否则生成
    const requestId = (req.headers['x-request-id'] || `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).toString();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
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
        if (route === '/metrics') {
            res.writeHead(200);
            res.end(JSON.stringify(metricsReport(), null, 2));
            return;
        }
        if (route !== '/analyze') {
            res.writeHead(404);
            res.end(JSON.stringify({ ok: false, error: '未知端点' }));
            return;
        }
        const method = (req.method || 'GET').toUpperCase();

        // ====== 解析参数 + 图片（GET=路径/POST=base64 body）======
        let task = 'general', lang = 'zh', desc = '', focus = '', user = 'local', forceAction = null, raw = false;
        let cropBbox = null;
        /** @type {string[]} 图片虚拟或真实路径（仅用于日志/响应展示） */
        let imgPaths = [];
        /** @type {Buffer[]} */
        let rawBufs = [];

        if (method === 'POST') {
            // 读取 JSON body（限制大小：6 张图 base64 约 ≈ 30MB，加 64MB 冗余）
            const BODY_LIMIT = 64 * 1024 * 1024;
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > BODY_LIMIT) {
                    res.writeHead(413);
                    res.end(JSON.stringify({ ok: false, error: '请求体过大，上限 64MB' }));
                    return;
                }
                chunks.push(chunk);
            }
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
            catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'POST body 不是合法 JSON' })); return; }

            task = String(body.task || 'general');
            lang = String(body.lang || 'zh');
            desc = String(body.desc || '');
            focus = String(body.focus || '');
            user = String(body.user || 'remote');
            forceAction = body.force_action ? String(body.force_action) : null;
            raw = body.raw === true || body.raw === 1;
            if (body.crop_bbox) cropBbox = parseCropBbox(body.crop_bbox) || null;
            // task 自动路由：根据 desc/focus 关键词推断
            task = routeTaskByContext(task, desc, focus);

            const imgs = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
            if (!imgs.length) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: 'POST body 必须带 images: [{base64}] 数组（1~6 张）' }));
                return;
            }
            for (let i = 0; i < imgs.length; i++) {
                const item = imgs[i] || {};
                let b64 = String(item.base64 || '').trim();
                if (!b64) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: `images[${i}].base64 为空` })); return; }
                // 兼容带前缀：data:image/png;base64,xxxx
                const m = b64.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
                if (m) b64 = m[1];
                let buf;
                try { buf = Buffer.from(b64, 'base64'); }
                catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: `images[${i}].base64 非法` })); return; }
                rawBufs.push(buf);
                imgPaths.push(`remote-base64-#${i}`);
            }
        } else {
            // GET：原逻辑，从 queryString + 本地文件取图
            task = urlObj.searchParams.get('task') || 'general';
            lang = urlObj.searchParams.get('lang') || 'zh';
            desc = urlObj.searchParams.get('desc') || '';
            focus = urlObj.searchParams.get('focus') || '';
            user = urlObj.searchParams.get('user') || 'local';
            forceAction = urlObj.searchParams.get('force_action');
            raw = urlObj.searchParams.get('raw') === '1';
            try {
                const c = urlObj.searchParams.get('crop_bbox');
                if (c) cropBbox = parseCropBbox(JSON.parse(c));
            } catch { /* 非法 bbox 忽略 */ }
            // task 自动路由：根据 desc/focus 关键词推断
            task = routeTaskByContext(task, desc, focus);

            imgPaths = urlObj.searchParams.getAll('paths').map((p) => p.trim()).filter(Boolean);
            const singlePath = urlObj.searchParams.get('path');
            if (imgPaths.length === 0 && singlePath) imgPaths = [singlePath];
            if (imgPaths.length === 0) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: '缺少path参数，示例：/analyze?path=E:\\temp\\test.png（多图：&paths=图1&paths=图2）或用 POST /analyze 传 images base64' }));
                return;
            }
            if (imgPaths.length > 6) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: '一次最多分析 6 张图' }));
                return;
            }
            const missing = imgPaths.filter((p) => !fs.existsSync(p));
            if (missing.length) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: `文件不存在: ${missing.join(' | ')}` }));
                return;
            }
            rawBufs = imgPaths.map((p) => fs.readFileSync(p));
        }

        // 限流
        const rl = rateLimit(user);
        if (rl.limited) {
            res.writeHead(429, { 'Retry-After': String(rl.retryAfter) });
            res.end(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后重试', retry_after: rl.retryAfter }));
            return;
        }

        const imgMd5s = rawBufs.map((b) => crypto.createHash('md5').update(b).digest('hex'));
        const mergedMd5 = crypto.createHash('md5').update(Buffer.concat(rawBufs)).digest('hex');

        let analysisRes, provider = null, modelUsed = null, usage = null, cacheHit = 'miss', upstreamRaw = null;
        let compressedBytesList = null, anyCropped = false, sliceCount = 0;
        const cacheKey = `${mergedMd5}|${task}|${lang}|${desc}|${focus}|${PRIMARY_CFG.model}`;

        const cached = !forceAction && !raw ? cacheGet(cacheKey) : null;
        if (cached) {
            cacheHit = 'hit';
            analysisRes = cached;
        } else if (forceAction === 'continue' || forceAction === 'stop') {
            analysisRes = {
                raw: '',
                analysis: `（测试钩子 force_action=${forceAction}，${imgPaths.length} 张图）`,
                action: forceAction,
                reason: 'force_action 测试钩子',
                status: 'ok'
            };
        } else {
            // 单图场景：先做超长图切片（仅单图，多图保持原样避免顺序混乱）
            let effectiveBufs = rawBufs;
            if (rawBufs.length === 1 && !cropBbox) {
                const slices = await sliceLongImage(rawBufs[0]);
                if (slices.length > 1) {
                    effectiveBufs = slices;
                    sliceCount = slices.length;
                }
            } else if (rawBufs.length === 1 && cropBbox) {
                // cropBbox 已把局部裁剪放大 → 不再切片
            }

            // 并行压缩 + 字节缓存命中短路；第 0 张若有 cropBbox 则先裁剪放大再压缩
            // 每段独立选格式（照片 WebP / UI PNG）；task=ocr 时对每段先二值化预处理
            const compressResults = await Promise.all(effectiveBufs.map(async (rawBuf, i) => {
                // 切片场景用 sub-md5（每段独立）；非切片用原 md5
                const md5 = sliceCount ? `${imgMd5s[0]}#slice-${i}` : imgMd5s[i];
                const croppedBuf = (i === 0 && cropBbox) ? await cropAndEnlarge(rawBuf, cropBbox) : null;
                let finalBuf = croppedBuf || rawBuf;
                // 裁剪后的内容不复用字节缓存（图像已变）；未裁剪且命中缓存直接返回
                if (!croppedBuf) {
                    const hit = imgCacheGet(md5);
                    if (hit) return { base64: hit.base64, compressedBytes: hit.compressedBytes, cropped: false };
                }
                // task=ocr 时做二值化预处理（裁剪过的图也走二值化）
                if (task === 'ocr') {
                    finalBuf = await ocrPreprocess(finalBuf) || finalBuf;
                }
                // 按图本身格式选输出（照片 WebP / UI PNG）
                const fmt = await chooseFormat(finalBuf);
                const compressOpts = fmt.quality
                    ? { quality: fmt.quality }
                    : {};
                const compressedBuf = await sharp(finalBuf)
                    .resize({ width: MAX_LONG_SIDE, height: MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true })
                    .toFormat(fmt.format, compressOpts)
                    .toBuffer();
                const b64 = compressedBuf.toString('base64');
                if (!croppedBuf) imgCacheSet(md5, b64, compressedBuf.length);
                return { base64: b64, compressedBytes: compressedBuf.length, cropped: !!croppedBuf };
            }));
            const base64Images = compressResults.map(r => r.base64);
            compressedBytesList = compressResults.map(r => r.compressedBytes);
            anyCropped = compressResults.some(r => r.cropped);
            const prompt = buildPrompt(task, lang, desc, focus);
            if (sliceCount > 1) {
                // 切片后告诉模型每段是什么
                const sliceHint = `（注：原图超长已切成 ${sliceCount} 段，按顺序传入；analysis 请综合各段，next_action 仍按整体判断）`;
                const up = await analyzeImage({ base64Images, prompt: prompt + sliceHint });
                provider = up.provider; modelUsed = up.model; usage = up.usage;
                upstreamRaw = up.content;
                analysisRes = extractAnalysis(up.content);
                cacheSet(cacheKey, analysisRes);
            } else {
                const up = await analyzeImage({ base64Images, prompt });
                provider = up.provider; modelUsed = up.model; usage = up.usage;
                upstreamRaw = up.content;
                analysisRes = extractAnalysis(up.content);
                cacheSet(cacheKey, analysisRes);
            }
        }

        if (raw) {
            res.writeHead(200);
            res.end(JSON.stringify(upstreamRaw
                ? { content: upstreamRaw, usage, provider, model: modelUsed }
                : { note: 'raw 仅在真实模型调用时返回原始内容', forced: !!forceAction }));
            return;
        }

        const imagesField = imgPaths.map((p, i) => ({
            path: p, md5: imgMd5s[i], bytes: rawBufs[i].length,
            compressed_bytes: compressedBytesList ? compressedBytesList[i] : null
        }));

        const body = {
            ok: true,
            images: imagesField,
            image: imgPaths.length === 1 ? imagesField[0] : undefined, // 单图兼容旧字段
            analysis: { text: analysisRes.analysis, raw: analysisRes.raw, keywords: analysisRes.keywords || [], annotated_text: analysisRes.annotatedText || '', verbatim: analysisRes.verbatim || '', regions: analysisRes.regions || [], verdict: analysisRes.verdict ?? null, evidence: analysisRes.evidence || '' },
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
                focus: focus || undefined,
                crop_bbox: cropBbox || undefined,
                cropped: anyCropped,
                slices: sliceCount > 1 ? sliceCount : undefined,
                parse: analysisRes.status,
                cache: cacheHit,
                image_count: imgPaths.length,
                latency_ms: Date.now() - start,
                forced: !!forceAction,
                bridge_version: VERSION,
                request_id: requestId
            }
        };

        usageLog({
            user, md5: mergedMd5, image_count: imgPaths.length, task, lang,
            provider: provider || null, model: modelUsed || PRIMARY_CFG.model,
            usage, action: analysisRes.action, cache: cacheHit,
            latency_ms: body.meta.latency_ms, status: 200, request_id: requestId
        });

        // 分析历史持久化（不管 cache hit/miss 都记录；force_action 不记）
        if (!forceAction) {
            historyLog({
                request_id: requestId, user,
                md5: mergedMd5, image_count: imgPaths.length,
                task, lang, desc: desc || undefined, focus: focus || undefined,
                provider: provider || null, model: modelUsed || PRIMARY_CFG.model,
                action: analysisRes.action,
                analysis: String(analysisRes.analysis || '').slice(0, 2000),
                keywords: analysisRes.keywords || [],
                regions: (analysisRes.regions || []).slice(0, 5),
                cache: cacheHit, latency_ms: body.meta.latency_ms
            });
        }

        metricsObserve({
            user, task, provider: provider || (forceAction ? 'forced' : cacheHit === 'hit' ? 'cache' : 'unknown'),
            latencyMs: body.meta.latency_ms, cache: cacheHit, ok: true
        });

        res.writeHead(200);
        res.end(JSON.stringify(body, null, 2));
    } catch (err) {
        const status = err.providerErrors ? 502 : 500;
        usageLog({ user: 'unknown', error: err.message, status, request_id: requestId });
        metricsObserve({
            ok: false, latencyMs: Date.now() - start,
            errorType: err.providerErrors ? 'all_providers_failed' : 'internal'
        });
        res.writeHead(status);
        res.end(JSON.stringify({ ok: false, error: err.message, request_id: requestId, stack: process.env.DEBUG ? err.stack : undefined }));
    }
});

if (require.main === module) {
    server.listen(LISTEN_PORT, '127.0.0.1', () => {
        console.log(`✅图像分析桥接服务 v${VERSION} 已启动，端口 ${LISTEN_PORT}，模型 ${PRIMARY_CFG.model}`);
        console.log(`👉调用示例：http://127.0.0.1:${LISTEN_PORT}/analyze?path=E:\\temp\\screenshot.png`);
    });
}

module.exports = { extractAnalysis, buildPrompt, parseRegions, parseCropBbox, cropAndEnlarge, chooseFormat, sliceLongImage, ocrPreprocess, rateLimit, cacheGet, cacheSet, imgCacheGet, imgCacheSet, routeTaskByContext, metricsObserve, metricsReport, _resetCaches: () => { cache.clear(); imgCache.clear(); }, _resetMetrics: () => { metrics.requests = 0; metrics.errors = 0; metrics.cacheHits = 0; metrics.cacheMisses = 0; metrics.latencies = []; metrics.byTask.clear(); metrics.byProvider.clear(); metrics.byUser.clear(); metrics.errorTypes.clear(); } };
