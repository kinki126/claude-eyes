// ============================================================
// analyze-tool.js —— analyze_image 工具的共享逻辑（stdio/http 复用）
//   - ensureBridge(): 探测 /health，不通则自动 spawn 桥接进程
//   - createAnalyzeImageHandler(): 工具处理函数，桥接薄客户端
// ============================================================

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MCP 目录(mcp-image-analyzer)的父目录 = 项目根
const PROJECT_ROOT = path.resolve(__dirname, '..');

const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:8765';
// 桥接脚本路径：优先环境变量（相对则相对项目根解析），默认 <项目根>\zhipu-bridge-api.js
const BRIDGE_SCRIPT_PATH = process.env.BRIDGE_SCRIPT_PATH
    ? path.resolve(PROJECT_ROOT, process.env.BRIDGE_SCRIPT_PATH)
    : path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
const AUTO_SPAWN_BRIDGE = process.env.AUTO_SPAWN_BRIDGE !== '0';
const MCP_USER = process.env.MCP_USER || '';

// analyze_image 工具对外暴露的全部参数（测试锚点 + 文档参考）。
// bridge 端额外接受 user/force_action/raw/desc 等 URL/body 参数，但工具层不暴露给 Claude。
const SUPPORTED_TOOL_PARAMS = [
    'path', 'paths', 'image_base64', 'images_base64',
    'task', 'lang', 'description', 'focus', 'crop_bbox'
];

// 远程 HTTP 入口通过 userContext.run({user}) 注入每个请求的 X-User
export const userContext = new AsyncLocalStorage();

// P0-2: 通过 MCP notification 向客户端推送进度信息（不阻塞主流程，失败静默忽略）
// extra 是 MCP tool handler 的第二参数，含 sendNotification 方法
function makeProgressSender(extra) {
    return (message, level = 'info') => {
        try {
            if (extra?.sendNotification) {
                extra.sendNotification({
                    method: 'notifications/message',
                    params: { level, data: message, logger: 'analyze-image' }
                });
            }
        } catch {
            /* 静默：notification 失败不影响主流程 */
        }
    };
}

async function isBridgeUp(baseUrl = BRIDGE_BASE_URL, timeoutMs = 500) {
    try {
        await axios.get(`${baseUrl}/health`, { timeout: timeoutMs });
        return true;
    } catch {
        return false;
    }
}

/** 确保桥接在线：不通且允许自动拉起时 spawn，然后轮询 /health（最多 3 次拉起 × 2.5s） */
export async function ensureBridge(baseUrl = BRIDGE_BASE_URL) {
    if (await isBridgeUp(baseUrl)) return true;
    if (!AUTO_SPAWN_BRIDGE) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const child = spawn(process.execPath, [BRIDGE_SCRIPT_PATH], {
                cwd: path.dirname(BRIDGE_SCRIPT_PATH),
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
        } catch {
            /* 尝试下一次 */
        }
        // 每次拉起后轮询最多 ~2.5s（桥接冷启动 + 端口 TIME_WAIT 竞争）
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (await isBridgeUp(baseUrl, 400)) return true;
        }
    }
    return false;
}

/**
 * 创建 analyze_image 处理函数。
 * @param {object} opts
 * @param {string} [opts.bridgeBaseUrl] 桥接地址
 * @param {string} [opts.user]          兜底用户标识（远程由 userContext 覆盖）
 */
export function createAnalyzeImageHandler({ bridgeBaseUrl = BRIDGE_BASE_URL, user = MCP_USER } = {}) {
    return async ({ path, paths, description, task, lang, focus, crop_bbox, image_base64, images_base64 }, extra) => {
        const sendProgress = makeProgressSender(extra);
        // 图片来源：本地路径 或 直接 base64（远程模式下 bridge 拿不到客户端本地文件时用）
        const hasBase64 = Boolean(image_base64) || (Array.isArray(images_base64) && images_base64.length);
        const imgList = (Array.isArray(paths) && paths.length) ? paths.slice(0, 6) : (path ? [path] : []);
        if (imgList.length === 0 && !hasBase64) {
            return { isError: true, content: [{ type: 'text', text: '缺少参数：请传 path/paths（本地路径） 或 image_base64/images_base64（base64 内容）。' }] };
        }

        const imgCount = imgList.length || (Array.isArray(images_base64) ? images_base64.length : (image_base64 ? 1 : 0));
        sendProgress(`准备分析 ${imgCount} 张图（task=${task || 'general'}）...`);
        if (!(await ensureBridge(bridgeBaseUrl))) {
            return {
                isError: true,
                content: [{ type: 'text', text: `图像分析桥接服务未启动，且自动拉起失败。请手动运行: node ${BRIDGE_SCRIPT_PATH}（确认 8765 端口监听）。` }]
            };
        }

        sendProgress('桥接服务已就绪，正在' + (hasBase64 ? '上传' : '读取') + '图片...');

        try {
            const b64List = hasBase64
                ? (Array.isArray(images_base64) ? images_base64.slice(0, 6) : [image_base64])
                : [];

            // 若有 base64 → 走 POST /analyze（multipart 不安全，直接 JSON body）
            if (hasBase64) {
                const requestId = `mcp-${randomUUID()}`;
                const reqBody = {
                    images: b64List.map(b64 => ({ base64: b64 })),
                    task: task || 'general',
                    lang: lang || 'zh',
                    desc: description || '',
                    focus: focus || '',
                    crop_bbox
                };
                const activeUser = userContext.getStore()?.user || user;
                if (activeUser) reqBody.user = activeUser;
                sendProgress('正在调用视觉模型分析（可能需要 3-15 秒）...');
                const resp = await axios.post(`${bridgeBaseUrl}/analyze`, reqBody, {
                    timeout: 65000,
                    headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId }
                });
                const body = resp.data;
                if (!body || body.ok === false) {
                    throw new Error(body?.error || `桥接返回异常: HTTP ${resp.status}`);
                }
                const out = {
                    images: body.images || [],
                    image: body.image,
                    analysis: body.analysis.text || body.analysis.raw || '(模型未返回分析内容)',
                    keywords: body.analysis.keywords || [],
                    annotated_text: body.analysis.annotated_text || '',
                    verbatim: body.analysis.verbatim || '',
                    regions: body.analysis.regions || [],
                    verdict: body.analysis.verdict ?? null,
                    evidence: body.analysis.evidence || '',
                    control: body.control,
                    meta: {
                        model: body.meta.model,
                        provider: body.meta.provider,
                        parse: body.meta.parse,
                        cache: body.meta.cache,
                        image_count: body.meta.image_count || b64List.length,
                        latency_ms: body.meta.latency_ms,
                        request_id: body.meta.request_id || requestId
                    }
                };
                return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
            }

            // 本地路径 → 继续走 GET /analyze（向后兼容）
            const requestId = `mcp-${randomUUID()}`;
            const qs = new URLSearchParams();
            if (imgList.length === 1) {
                qs.set('path', imgList[0]);
            } else {
                for (const p of imgList) qs.append('paths', p);
            }
            if (description) qs.set('desc', description);
            if (focus) qs.set('focus', focus);
            if (crop_bbox && typeof crop_bbox === 'object') qs.set('crop_bbox', JSON.stringify(crop_bbox));
            qs.set('task', task || 'general');
            qs.set('lang', lang || 'zh');
            const activeUser = userContext.getStore()?.user || user;
            if (activeUser) qs.set('user', activeUser);

            sendProgress('正在调用视觉模型分析（可能需要 3-15 秒）...');
            const resp = await axios.get(`${bridgeBaseUrl}/analyze?${qs.toString()}`, {
                timeout: 65000,
                headers: { 'X-Request-Id': requestId }
            });
            const body = resp.data;
            if (!body || body.ok === false) {
                throw new Error(body?.error || `桥接返回异常: HTTP ${resp.status}`);
            }

            const out = {
                images: body.images || (body.image ? [body.image] : []),
                image: body.image || (body.images && body.images[0]),
                analysis: body.analysis.text || body.analysis.raw || '(模型未返回分析内容)',
                keywords: body.analysis.keywords || [],
                annotated_text: body.analysis.annotated_text || '',
                verbatim: body.analysis.verbatim || '',
                regions: body.analysis.regions || [],
                verdict: body.analysis.verdict ?? null,
                evidence: body.analysis.evidence || '',
                control: body.control,
                meta: {
                    model: body.meta.model,
                    provider: body.meta.provider,
                    parse: body.meta.parse,
                    cache: body.meta.cache,
                    image_count: body.meta.image_count || imgList.length,
                    latency_ms: body.meta.latency_ms,
                    request_id: body.meta.request_id || requestId
                }
            };
            sendProgress('分析完成，正在返回结果...');
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
            const hint = err.code === 'ECONNREFUSED'
                ? `图像分析桥接服务未启动。请先运行: node ${BRIDGE_SCRIPT_PATH}（确认 8765 端口监听）。`
                : '';
            sendProgress('分析失败：' + err.message, 'error');
            return { isError: true, content: [{ type: 'text', text: `${hint} 详细: ${err.message}` }] };
        }
    };
}

// P1-1: locate_code 工具 —— 用 Node 原生遍历搜索 keywords，返回结构化候选
// 在 MCP 工具层实现（而非 bridge 端），因为它需要访问客户端本地项目代码
// 只返回 { file, line, match } 三元组；上下文行交给 Claude 用 Read 工具读，保持工具单一职责

// Node 原生搜索要跳过的目录（依赖/构建/产物，避免扫到 node_modules 拖慢）
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.claude-eyes', 'logs', 'shots', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', 'venv', '.idea']);
const MAX_FILES_SCAN = 3000; // 单次扫描最多处理的文件数（防大项目拖慢）

/** 递归收集 root 下匹配扩展名的文件（排除依赖/构建目录） */
function collectFiles(root, exts, limit) {
    const files = [];
    const walk = (dir) => {
        if (files.length >= limit) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (files.length >= limit) return;
            if (e.isDirectory()) {
                if (EXCLUDE_DIRS.has(e.name)) continue;
                walk(path.join(dir, e.name));
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (exts.includes(ext)) files.push(path.join(dir, e.name));
            }
        }
    };
    walk(root);
    return files;
}

/** 判断一行匹配是否是"定义处"（声明关键词，而非注释/import 里的字符串引用） */
function isDefinition(match, kwLower) {
    const safeKw = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(function|const|let|var|class|async|export)\\s+${safeKw}\\b`, 'i').test(match);
}

/**
 * 创建 locate_code 处理函数。
 * @param {object} opts
 * @param {string} [opts.defaultProjectRoot] 默认项目根（兜底，优先用参数传入的）
 */
export function createLocateCodeHandler({ defaultProjectRoot = PROJECT_ROOT } = {}) {
    return async ({ keywords, project_root, max_hits_per_keyword, file_extensions }, extra) => {
        const sendProgress = (msg, level = 'info') => {
            try { extra?.sendNotification?.({ method: 'notifications/message', params: { level, data: msg, logger: 'locate-code' } }); } catch {}
        };

        if (!Array.isArray(keywords) || keywords.length === 0) {
            return { isError: true, content: [{ type: 'text', text: '缺少参数：keywords（字符串数组，1~10 个）。' }] };
        }
        if (keywords.length > 10) {
            return { isError: true, content: [{ type: 'text', text: 'keywords 最多 10 个。' }] };
        }
        const root = project_root || defaultProjectRoot;
        const maxHits = Math.min(max_hits_per_keyword || 5, 20);
        const exts = Array.isArray(file_extensions) && file_extensions.length
            ? file_extensions
            : ['.js', '.mjs', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.json', '.yaml', '.yml', '.vue', '.svelte'];

        sendProgress(`正在搜索 ${keywords.length} 个关键词（项目根：${root}）...`);

        // 搜索后端：Node 原生遍历 + 字符串匹配（不依赖 rg/findstr/grep 外部工具，跨平台稳定；
        // rg 在 Git Bash 里是 function/alias，在 cmd.exe 的 execSync 下不可用，findstr 多扩展名写法也有坑）
        const searchEngine = 'node-native';
        const files = collectFiles(root, exts, MAX_FILES_SCAN);
        const results = [];
        for (const kw of keywords) {
            const kwLower = kw.toLowerCase();
            const hits = [];
            for (const file of files) {
                if (hits.length >= 500) break; // 宽松上限，防极端项目内存爆炸
                let content;
                try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (hits.length >= 500) break;
                    if (lines[i].toLowerCase().includes(kwLower)) {
                        hits.push({ file, line: i + 1, match: lines[i].trim().slice(0, 200) });
                    }
                }
            }
            // 定义处优先：声明（function/const/...）排前面，用户找的是定义而非注释/import 里的引用；
            // 排序后再截断 maxHits，避免定义处被前面的字符串引用挤掉
            hits.sort((a, b) => (isDefinition(b.match, kwLower) ? 1 : 0) - (isDefinition(a.match, kwLower) ? 1 : 0));
            results.push({ keyword: kw, hits_count: hits.length, hits: hits.slice(0, maxHits) });
        }

        const totalHits = results.reduce((s, r) => s + r.hits_count, 0);
        sendProgress(`搜索完成：${totalHits} 个候选命中`);

        const summary = {
            project_root: root,
            search_engine: searchEngine,
            total_hits: totalHits,
            keywords_searched: keywords.length,
            results
        };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    };
}

/**
 * 创建 search_history 处理函数（P2-4）：通过 bridge 的 /history 端点搜索历史分析记录
 * @param {object} opts
 * @param {string} [opts.bridgeBaseUrl] 桥接地址
 */
export function createSearchHistoryHandler({ bridgeBaseUrl = BRIDGE_BASE_URL } = {}) {
    return async ({ task, keyword, since, until, limit, user }, extra) => {
        const sendProgress = (msg, level = 'info') => {
            try { extra?.sendNotification?.({ method: 'notifications/message', params: { level, data: msg, logger: 'search-history' } }); } catch {}
        };

        if (!(await ensureBridge(bridgeBaseUrl))) {
            return { isError: true, content: [{ type: 'text', text: `图像分析桥接服务未启动，且自动拉起失败。请手动运行: node ${BRIDGE_SCRIPT_PATH}（确认 8765 端口监听）。` }] };
        }

        sendProgress('正在搜索历史记录...');
        try {
            const qs = new URLSearchParams();
            if (task) qs.set('task', task);
            if (keyword) qs.set('keyword', keyword);
            if (since) qs.set('since', since);
            if (until) qs.set('until', until);
            if (limit) qs.set('limit', String(limit));
            if (user) qs.set('user', user);
            const requestId = `mcp-hist-${randomUUID()}`;
            const resp = await axios.get(`${bridgeBaseUrl}/history?${qs.toString()}`, {
                timeout: 10000,
                headers: { 'X-Request-Id': requestId }
            });
            const body = resp.data;
            if (!body || body.ok === false) {
                throw new Error(body?.error || `桥接返回异常: HTTP ${resp.status}`);
            }
            sendProgress(`搜索完成：共 ${body.total} 条，返回 ${body.returned} 条`);
            return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
        } catch (err) {
            sendProgress('搜索失败：' + err.message, 'error');
            return { isError: true, content: [{ type: 'text', text: `搜索历史失败：${err.message}` }] };
        }
    };
}

