// ============================================================
// analyze-tool.js —— analyze_image 工具的共享逻辑（stdio/http 复用）
//   - ensureBridge(): 探测 /health，不通则自动 spawn 桥接进程
//   - createAnalyzeImageHandler(): 工具处理函数，桥接薄客户端
// ============================================================

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
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

// 远程 HTTP 入口通过 userContext.run({user}) 注入每个请求的 X-User
export const userContext = new AsyncLocalStorage();

async function isBridgeUp(timeoutMs = 500) {
    try {
        await axios.get(`${BRIDGE_BASE_URL}/health`, { timeout: timeoutMs });
        return true;
    } catch {
        return false;
    }
}

/** 确保桥接在线：不通且允许自动拉起时 spawn，然后轮询 /health（最多 3 次拉起 × 2.5s） */
export async function ensureBridge() {
    if (await isBridgeUp()) return true;
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
            if (await isBridgeUp(400)) return true;
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
    return async ({ path, paths, description, task, lang }) => {
        const imgList = (Array.isArray(paths) && paths.length) ? paths.slice(0, 6) : (path ? [path] : []);
        if (imgList.length === 0) {
            return { isError: true, content: [{ type: 'text', text: '缺少参数：请传 path（单张）或 paths（多张，最多 6 张，均为本地图片绝对路径）。' }] };
        }

        if (!(await ensureBridge())) {
            return {
                isError: true,
                content: [{ type: 'text', text: `图像分析桥接服务未启动，且自动拉起失败。请手动运行: node ${BRIDGE_SCRIPT_PATH}（确认 8765 端口监听）。` }]
            };
        }

        try {
            // 拼 URL 一律走 URLSearchParams（自动编码 Windows 反斜杠/冒号）
            const qs = new URLSearchParams();
            if (imgList.length === 1) {
                qs.set('path', imgList[0]);
            } else {
                for (const p of imgList) qs.append('paths', p);
            }
            if (description) qs.set('desc', description);
            qs.set('task', task || 'general');
            qs.set('lang', lang || 'zh');
            const activeUser = userContext.getStore()?.user || user;
            if (activeUser) qs.set('user', activeUser);

            const resp = await axios.get(`${bridgeBaseUrl}/analyze?${qs.toString()}`, { timeout: 65000 });
            const body = resp.data;
            if (!body || body.ok === false) {
                throw new Error(body?.error || `桥接返回异常: HTTP ${resp.status}`);
            }

            const out = {
                images: body.images || (body.image ? [body.image] : []),
                image: body.image || (body.images && body.images[0]),
                analysis: body.analysis.text || body.analysis.raw || '(模型未返回分析内容)',
                keywords: body.analysis.keywords || [],
                boxed_text: body.analysis.boxed_text || '',
                control: body.control,
                meta: {
                    model: body.meta.model,
                    provider: body.meta.provider,
                    parse: body.meta.parse,
                    cache: body.meta.cache,
                    image_count: body.meta.image_count || imgList.length,
                    latency_ms: body.meta.latency_ms
                }
            };
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
            const hint = err.code === 'ECONNREFUSED'
                ? `图像分析桥接服务未启动。请先运行: node ${BRIDGE_SCRIPT_PATH}（确认 8765 端口监听）。`
                : '';
            return { isError: true, content: [{ type: 'text', text: `${hint} 详细: ${err.message}` }] };
        }
    };
}
